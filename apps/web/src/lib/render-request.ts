import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectRenderRequested } from "@/inngest/events";
import { channelLogo } from "@/lib/media/logo";
import { busyStep, startProgress } from "@/lib/project-state";
import { assertQuota } from "@/lib/quota";
import type { Workspace } from "@/lib/workspace";

type Log = (type: string, payload?: Record<string, unknown>, projectId?: string) => Promise<unknown>;

/**
 * Queue a Remotion Lambda render of one timeline version (default: the latest).
 * Shared by the project page and the editor's export button, so both enforce the
 * busy lock and the daily render-minutes quota and log the same activity.
 * `logoChoice`: a channel id, "kit" (the kit's own logo), or undefined = the project's logo channel.
 * `skipQa`: force a render whose QA result does not gate it; only after this version already failed QA once.
 */
export async function queueRender(ws: Workspace, log: Log, input: { projectId: string; timelineId?: string; logoChoice?: string; skipQa?: boolean }) {
  const { projectId, timelineId, logoChoice } = input;
  const skipQa = Boolean(input.skipQa);
  const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }));
  if (!project) throw new Error("Project not found in this workspace");
  const busy = busyStep(project);
  if (busy) throw new Error(`Please wait: ${busy} is running`);
  const timeline = timelineId
    ? await withOrgContext(ws, (tx) => tx.query.timelines.findFirst({ where: and(eq(schema.timelines.projectId, projectId), eq(schema.timelines.id, timelineId)) }))
    : await withOrgContext(ws, (tx) => tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, projectId), orderBy: desc(schema.timelines.version) }));
  if (!timeline) throw new Error("Build the timeline first");
  if (skipQa) {
    const failed = await withOrgContext(ws, (tx) => tx.query.renders.findFirst({ where: and(eq(schema.renders.timelineId, timeline.id), eq(schema.renders.status, "qa_failed")), columns: { id: true } }));
    if (!failed) throw new Error("QA can only be skipped after a render of this version failed QA");
  }
  const logo = logoChoice && logoChoice !== "kit" ? await channelLogo(ws, logoChoice) : null;
  if (logoChoice && logoChoice !== "kit" && !logo) throw new Error("That channel has no logo (any more)");
  const minutes = Number(timeline.durationSec ?? 60) / 60;
  const quota = await assertQuota(ws.userId, "render_minutes");
  await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "render", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, projectId)));
  await inngest.send(projectRenderRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, timelineId: timeline.id, logoChannelId: logoChoice, ...(skipQa ? { skipQa: true } : {}) }));
  await log("quota.render_minutes", { minutes: Math.round(minutes * 100) / 100, timelineId: timeline.id }, projectId);
  await log("render.requested", { timelineId: timeline.id, version: timeline.version, logo: logo?.name ?? (logoChoice === "kit" ? "kit" : "project default"), quotaUsed: quota.used, quotaLimit: quota.limit, ...(skipQa ? { skipQa: true } : {}) }, projectId);
  return { skipQa, timelineId: timeline.id, version: timeline.version, logoName: logo?.name ?? null, minutesToday: Math.ceil(quota.used + minutes), minutesLimit: quota.limit };
}
