import { NonRetriableError } from "inngest";
import { eq } from "drizzle-orm";
import { inngest } from "../client";
import { publicationCancelled, publicationRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { flagEnabled } from "@/lib/flags";
import { notifySlack } from "@/lib/notify";
import { clientFor } from "@/lib/publish";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { applyCheck, buildJob, checkPublication, loadPublication, recordQuota } from "@/lib/publish/service";
import { PlatformError } from "@/lib/publish/types";

/** Inline polling budget after the upload; the 10-minute cron takes over afterwards. */
const INLINE_POLLS = 24;
const POLL_EVERY = "15s";

/**
 * Pipeline step 10 (docs/PLAN.md §4.10): waits until the scheduled time
 * (cancellable), uploads once per idempotency key, records the platform post
 * id immediately, then polls processing. Failures mark the row `failed`.
 */
export const publishPublicationFn = inngest.createFunction(
  {
    id: "publish-publication",
    triggers: [publicationRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.channelId" }, { limit: 5 }],
    cancelOn: [{ event: publicationCancelled, if: "async.data.publicationId == event.data.publicationId" }],
    onFailure: async ({ event }) => {
      const { publicationId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "publish failed";
      await withOrgContext({ userId: requestedBy, organizationId }, async (tx) => {
        const pub = await tx.query.publications.findFirst({ where: eq(schema.publications.id, publicationId), columns: { status: true, projectId: true, platform: true } });
        if (!pub || pub.status === "published" || pub.status === "cancelled") return;
        await tx.update(schema.publications).set({ status: "failed", error: message.slice(0, 2000) }).where(eq(schema.publications.id, publicationId));
        await logActivity({ actorId: requestedBy, organizationId, projectId: pub.projectId, type: "publication.failed", payload: { publicationId, platform: pub.platform, error: message.slice(0, 500) } });
        await notifySlack(`:x: Publish failed (${pub.platform}) ${publicationId}: ${message.slice(0, 300)}`);
      });
    },
  },
  async ({ event, step }) => {
    const { publicationId, organizationId, requestedBy } = event.data;
    const ctx = { userId: requestedBy, organizationId };

    const scheduled = await step.run("load", async () => {
      const data = await loadPublication(ctx, publicationId);
      if (!data) throw new NonRetriableError("Publication not found in this workspace");
      if (data.pub.status !== "scheduled") throw new NonRetriableError(`Publication is ${data.pub.status}, expected scheduled`);
      return { at: data.pub.scheduledAt?.toISOString() ?? null, platform: data.pub.platform, title: data.project?.title ?? null };
    });
    if (scheduled.at && new Date(scheduled.at).getTime() > Date.now() + 1000) {
      await step.sleepUntil("wait-for-schedule", new Date(scheduled.at));
    }

    const started = await step.run("upload", async () => {
      const data = await loadPublication(ctx, publicationId);
      if (!data) throw new NonRetriableError("Publication disappeared");
      const { pub, project } = data;
      if (pub.status === "cancelled") return { skipped: "cancelled" as const, state: null, title: project?.title ?? null };
      if (pub.status === "published") return { skipped: "published" as const, state: null, title: project?.title ?? null };
      // Idempotency: an earlier attempt of this run already handed the file over.
      if (pub.status === "processing" || pub.platformPostId || pub.metadata.handles) return { skipped: "already_uploaded" as const, state: "processing" as const, title: project?.title ?? null };
      if (!(await flagEnabled(PLATFORM_SPEC[pub.platform].flag))) throw new NonRetriableError(`${PLATFORM_SPEC[pub.platform].label} publishing is disabled in /admin/integrations`);
      if (project && project.state !== "rendered" && project.state !== "published") throw new NonRetriableError(`Project is ${project.state}; only approved, rendered projects can be published`);

      await withOrgContext(ctx, (tx) => tx.update(schema.publications).set({ status: "publishing", error: null }).where(eq(schema.publications.id, publicationId)));
      let job;
      try {
        job = await buildJob(ctx, publicationId);
      } catch (err) {
        if (err instanceof PlatformError && err.permanent) throw new NonRetriableError(err.message);
        throw err;
      }
      try {
        const res = await clientFor(pub.platform).start(job);
        await withOrgContext(ctx, (tx) =>
          tx
            .update(schema.publications)
            .set({
              status: res.state === "published" ? "published" : "processing",
              platformPostId: res.postId,
              platformUrl: res.url,
              publishedAt: res.state === "published" ? new Date() : null,
              lastCheckedAt: new Date(),
              metadata: { ...pub.metadata, handles: res.handles, sent: res.sent } as Record<string, unknown>,
            })
            .where(eq(schema.publications.id, publicationId)),
        );
        await recordQuota(pub.platform, res.quotaUnits, ctx, { projectId: pub.projectId, publicationId, op: "videos.insert" });
        await logActivity({ actorId: requestedBy, organizationId, projectId: pub.projectId, type: "publication.uploaded", payload: { publicationId, platform: pub.platform, postId: res.postId, attempt: pub.attempts, idempotencyKey: pub.idempotencyKey } });
        if (res.state === "published") {
          await applyCheck(ctx, { ...pub, metadata: { ...pub.metadata, handles: res.handles, sent: res.sent } }, { state: "published", postId: res.postId, url: res.url }, { title: project?.title });
        }
        return { skipped: null, state: res.state, title: project?.title ?? null };
      } catch (err) {
        if (err instanceof PlatformError && err.permanent) throw new NonRetriableError(err.message);
        throw err;
      }
    });
    if (started.skipped === "cancelled" || started.skipped === "published") return { publicationId, status: started.skipped };
    if (started.state === "published") return { publicationId, status: "published" };

    for (let i = 1; i <= INLINE_POLLS; i++) {
      await step.sleep(`wait-${i}`, POLL_EVERY);
      const status = await step.run(`check-${i}`, () => checkPublication(ctx, publicationId));
      if (status === "published") return { publicationId, status };
      if (status === "failed") throw new NonRetriableError("Platform reported a processing failure (see the publication row)");
      if (status !== "processing") return { publicationId, status };
    }
    // Still processing: the poll cron keeps checking every 10 minutes.
    return { publicationId, status: "processing" };
  },
);
