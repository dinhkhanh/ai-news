import { NonRetriableError } from "inngest";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Timeline } from "@ai-news/video/schema";
import { inngest } from "../client";
import { projectRenderRequested } from "../events";
import { reportProgress } from "@/lib/progress";
import { eventSuperseded } from "@/lib/project-state";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { env } from "@/lib/env";
import { channelLogo } from "@/lib/media/logo";
import { resolveTimelineSrcs } from "@/lib/media/timeline-resolve";
import { invokeMediaLambda, type MediaResult } from "@/lib/media-lambda";
import { notifySlack } from "@/lib/notify";
import { r2Key } from "@/lib/r2";
import { getRenderStatus, startRender } from "@/lib/remotion";

/** Media Lambda: 3008 MB, ~$0.0000000488/ms → ≈ $0.000049/s; rounded up for R2 traffic. */
const MEDIA_LAMBDA_USD_PER_SEC = 0.00006;

/**
 * Pipeline step 9 (docs/PLAN.md §4.9): Remotion Lambda renders the timeline
 * (raw output to R2 tmp/), the media Lambda normalises to -14 LUFS into
 * renders/, extracts the cover and runs the QA probe. Fails with a reason when
 * QA fails; notifies Slack when configured.
 */
export const renderProjectFn = inngest.createFunction(
  {
    id: "render-project",
    triggers: [projectRenderRequested],
    retries: 1,
    /** Global cap 5 = Inngest free-tier concurrency limit; per-project lock stays at 1. */
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 5 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "render failed";
      await withOrgContext({ userId: requestedBy, organizationId }, async (tx) => {
        await tx.update(schema.projects).set({ busyStep: null, busyProgress: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId));
        await tx.update(schema.renders).set({ status: "failed", error: message.slice(0, 4000) }).where(and(eq(schema.renders.projectId, projectId), eq(schema.renders.status, "rendering")));
      });
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "render.failed", payload: { error: message.slice(0, 500) } });
      await notifySlack(`:x: Render failed for project ${projectId}: ${message.slice(0, 300)}`);
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, timelineId, logoChannelId } = event.data;
    const skipQa = Boolean(event.data.skipQa);
    const ctx = { userId: requestedBy, organizationId };
    const pctx = { ...ctx, projectId };

    const input = await step.run("load", async () => {
      // The kit is shared by every channel, the logo is the channel's: this render's choice, else the project's; "kit" or a channel without a logo = the logo embedded in the timeline.
      const wanted = logoChannelId === "kit" ? null : (logoChannelId ?? (await withOrgContext(ctx, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { logoChannelId: true } })))?.logoChannelId ?? null);
      const logo = await channelLogo(ctx, wanted);
      const loaded = await withOrgContext(ctx, async (tx) => {
        const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
        if (!project) throw new NonRetriableError("Project not found in this workspace");
        const timeline = timelineId
          ? await tx.query.timelines.findFirst({ where: and(eq(schema.timelines.projectId, projectId), eq(schema.timelines.id, timelineId)) })
          : await tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, projectId), orderBy: desc(schema.timelines.version) });
        if (!timeline) throw new NonRetriableError("Build the timeline first");
        // A backlog draining after a queue outage: the same version + logo requested twice is rendered once (`eventSuperseded`).
        const sameLogo = logo?.id ? eq(schema.renders.logoChannelId, logo.id) : isNull(schema.renders.logoChannelId);
        const newer = await tx.query.renders.findFirst({ where: and(eq(schema.renders.projectId, projectId), eq(schema.renders.timelineId, timeline.id), sameLogo), orderBy: desc(schema.renders.createdAt), columns: { createdAt: true } });
        if (eventSuperseded(event.ts, { latestResultAt: newer?.createdAt })) return null;
        await tx.update(schema.projects).set({ busyStep: "render", lastError: null }).where(eq(schema.projects.id, projectId));
        const [render] = await tx
          .insert(schema.renders)
          .values({ organizationId, projectId, timelineId: timeline.id, timelineVersion: timeline.version, status: "queued", requestedBy, logoChannelId: logo?.id ?? null, logoPath: logo?.logoPath ?? (timeline.json as unknown as Timeline).brand.logoSrc ?? null })
          .returning({ id: schema.renders.id });
        return {
          renderId: render.id,
          timelineId: timeline.id,
          timelineVersion: timeline.version,
          // Stored versions are immutable; the logo is swapped on the copy that goes to Lambda.
          timeline: logo ? { ...(timeline.json as unknown as Timeline), brand: { ...(timeline.json as unknown as Timeline).brand, logoSrc: logo.logoPath } } : (timeline.json as unknown as Timeline),
          logoChannel: logo?.name ?? null,
          title: project.title ?? "ai-news",
          durationSec: Number(timeline.durationSec ?? 0),
          /** Only a render of the approved version advances the project (docs/PLAN.md §4.8); others are previews. */
          approved: project.approvedTimelineId === timeline.id,
        };
      });
      if (loaded) await reportProgress(pctx, { label: "Chuẩn bị timeline", pct: 2 });
      return loaded;
    });
    if (!input) return { projectId, skipped: "superseded" as const };
    const rawKey = r2Key.tmp(organizationId, projectId, `render-${input.renderId}-raw.mp4`);
    const outKey = r2Key.render(organizationId, projectId, `${input.renderId}.mp4`);
    const coverKey = r2Key.render(organizationId, projectId, `${input.renderId}-cover.jpg`);
    const durationSec = input.durationSec || input.timeline.durationFrames / 30;

    const started = await step.run("start-remotion-render", async () => {
      await reportProgress(pctx, { label: "Ký URL tài nguyên, khởi động Remotion Lambda", pct: 5 });
      const props = await resolveTimelineSrcs(input.timeline);
      const res = await startRender({ composition: "News", inputProps: props, outKey: rawKey, durationInFrames: input.timeline.durationFrames });
      await withOrgContext(ctx, (tx) =>
        tx.update(schema.renders).set({ status: "rendering", remotionRenderId: res.renderId, remotionBucket: res.bucketName, rawPath: rawKey }).where(eq(schema.renders.id, input.renderId)),
      );
      return { ...res, t0: Date.now() };
    });

    let remotionCost = 0;
    for (let attempt = 1; ; attempt++) {
      const status = await step.run(`poll-${attempt}`, async () => {
        const s = await getRenderStatus(started);
        const p = Math.max(0, Math.min(1, s.overallProgress ?? 0));
        await reportProgress(pctx, { label: s.done ? "Lambda kết xuất xong" : `Remotion Lambda đang kết xuất (${s.framesRendered ?? 0}/${input.timeline.durationFrames} khung hình)`, pct: Math.round(8 + 70 * p) });
        return s;
      });
      if (status.fatalErrorEncountered) {
        const msg = status.errors.map((e: { message: string }) => e.message).join("\n");
        await step.run("mark-failed", () => withOrgContext(ctx, (tx) => tx.update(schema.renders).set({ status: "failed", error: msg.slice(0, 4000) }).where(eq(schema.renders.id, input.renderId))));
        throw new NonRetriableError(`Remotion render failed: ${status.errors[0]?.message ?? "unknown"}`);
      }
      if (status.done) {
        remotionCost = status.costs.accruedSoFar;
        break;
      }
      if (attempt > 90) throw new NonRetriableError("Render did not finish within the polling budget (7.5 min)");
      await step.sleep(`wait-${attempt}`, "5s");
    }

    const post = await step.run("post-process", async () => {
      await reportProgress(pctx, { label: skipQa ? "Chuẩn hoá −14 LUFS, cắt ảnh bìa (bỏ qua QA)" : "Chuẩn hoá −14 LUFS, cắt ảnh bìa, QA (media Lambda)", pct: 80 });
      await withOrgContext(ctx, (tx) => tx.update(schema.renders).set({ status: "post_processing" }).where(eq(schema.renders.id, input.renderId)));
      const t0 = Date.now();
      const norm = await invokeMediaLambda({ action: "loudnorm", input: { key: rawKey }, output: { key: outKey }, targetLufs: -14, truePeak: -1 });
      if (!norm.ok) throw new Error(`loudnorm failed: ${norm.error}`);
      const coverAt = input.timeline.coverAtSec != null ? Math.min(Math.max(0, input.timeline.coverAtSec), Math.max(0, durationSec - 0.2)) : Math.min(1.2, durationSec / 3);
      const cover = await invokeMediaLambda({ action: "cover", input: { key: outKey }, output: { key: coverKey }, atSec: coverAt });
      const qa: MediaResult = await invokeMediaLambda({
        action: "probe",
        input: { key: outKey },
        expect: { width: 1080, height: 1920, fps: 30, minDurationSec: durationSec - 0.7, maxDurationSec: durationSec + 0.7, lufs: -14, truePeakDb: -1 },
      });
      const lambdaMs = (norm.billedMs ?? 0) + (cover.billedMs ?? 0) + (qa.billedMs ?? 0) + (Date.now() - t0) * 0.1;
      return { qa, coverOk: cover.ok, lambdaMs };
    });

    await step.run("finalise", async () => {
      await reportProgress(pctx, { label: "Ghi kết quả", pct: 96 });
      const qaPassed = Boolean(post.qa.ok && post.qa.passed);
      // A forced render: the probe is kept for the record, the user's override decides.
      const overridden = skipQa && !qaPassed;
      const passed = qaPassed || skipQa;
      const qaError = post.qa.error ?? "QA probe failed: " + Object.entries(post.qa.checks ?? {}).filter(([, c]) => !c.ok).map(([k, c]) => `${k} expected ${String(c.expected)} got ${String(c.actual)}`).join("; ");
      const mediaCost = (post.lambdaMs / 1000) * MEDIA_LAMBDA_USD_PER_SEC;
      const costUsd = remotionCost + mediaCost;
      const renderSeconds = (Date.now() - started.t0) / 1000;
      await withOrgContext(ctx, async (tx) => {
        await tx
          .update(schema.renders)
          .set({
            status: passed ? "done" : "qa_failed",
            outputPath: outKey,
            coverPath: post.coverOk ? coverKey : null,
            durationSec: post.qa.probe?.durationSec?.toFixed(2),
            costUsd: costUsd.toFixed(4),
            renderSeconds: renderSeconds.toFixed(2),
            qaJson: { ...(post.qa as unknown as Record<string, unknown>), ...(overridden ? { overridden: true, overriddenBy: requestedBy } : {}) },
            error: passed ? null : qaError,
          })
          .where(eq(schema.renders.id, input.renderId));
        const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
        const state = passed && input.approved ? "rendered" : project?.state;
        await tx.update(schema.projects).set({ state, busyStep: null, busyProgress: null, lastError: passed ? null : "Render QA failed; see the render row" }).where(eq(schema.projects.id, projectId));
      });
      await recordUsageCost({ provider: "remotion_lambda", resource: "News", units: durationSec, unitType: "render_seconds", costUsd: remotionCost, userId: requestedBy, organizationId, projectId, renderId: input.renderId, meta: { renderSeconds, functionName: env().REMOTION_FUNCTION_NAME } });
      await recordUsageCost({ provider: "media_lambda", resource: "loudnorm+cover+probe", units: post.lambdaMs / 1000, unitType: "seconds", costUsd: mediaCost, userId: requestedBy, organizationId, projectId, renderId: input.renderId });
      await logActivity({
        actorId: requestedBy, organizationId, projectId, type: passed ? "render.completed" : "render.qa_failed",
        payload: { renderId: input.renderId, timelineVersion: input.timelineVersion, approved: input.approved, durationSec: post.qa.probe?.durationSec ?? null, lufs: post.qa.probe?.integratedLufs ?? null, costUsd, renderSeconds, checks: post.qa.checks ?? null, ...(overridden ? { qaOverridden: true, qaError } : {}) },
      });
      await notifySlack(`${passed ? (input.approved ? ":clapper: Render done" : ":clapper: Preview render done") : ":warning: Render QA failed"}${overridden ? " (QA overridden)" : ""} — ${input.title} (${durationSec.toFixed(0)}s, $${costUsd.toFixed(3)}) ${env().APP_URL}/app/projects/${projectId}`);
    });

    return { renderId: input.renderId, outKey, passed: Boolean(post.qa.ok && post.qa.passed) || skipQa, qaSkipped: skipQa };
  },
);
