import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { assertQuota } from "@/lib/quota";
import { projectAssetsRequested, projectRenderRequested, projectScriptRequested } from "./events";

/** Minimum article length `confirmArticle` accepts; shorter articles pause auto mode for a human look. */
export const AUTO_MIN_WORDS = 40;

type Ctx = { userId: string; organizationId: string };

/**
 * Auto mode (`projects.auto_pipeline`): each pipeline function calls one of
 * these at its end. They decide whether the next step should start and, if so,
 * do the same bookkeeping the matching server action does (article confirm,
 * quota check, `busy_step`) and return the event to send. Returning `null`
 * means "stop here and wait for a human" — never throw, because the step that
 * just finished has already been stored and must not be reported as failed.
 */
async function loadAuto(ctx: Ctx, projectId: string) {
  const project = await withOrgContext(ctx, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }));
  return project?.autoPipeline ? project : null;
}

async function pause(ctx: Ctx, projectId: string, step: string, reason: string) {
  await withOrgContext(ctx, (tx) => tx.update(schema.projects).set({ lastError: `Tự động dừng trước bước ${step}: ${reason}`.slice(0, 2000) }).where(eq(schema.projects.id, projectId)));
  await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId, type: "auto.paused", payload: { step, reason } });
  return null;
}

/** After `fetch-article`: confirm the article on the requester's behalf and queue the script. */
export async function autoAfterFetch(ctx: Ctx, projectId: string) {
  const project = await loadAuto(ctx, projectId);
  if (!project) return null;
  const article = await withOrgContext(ctx, (tx) => tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) }));
  if (!article) return pause(ctx, projectId, "script", "không có bài");
  if (article.wordCount < AUTO_MIN_WORDS) return pause(ctx, projectId, "script", `bài chỉ có ${article.wordCount} từ, cần kiểm tra và xác nhận thủ công`);
  try {
    await assertQuota(ctx.userId, "scripts");
  } catch (e) {
    return pause(ctx, projectId, "script", e instanceof Error ? e.message : String(e));
  }
  await withOrgContext(ctx, async (tx) => {
    if (!article.confirmedAt) await tx.update(schema.articles).set({ confirmedAt: new Date(), confirmedBy: ctx.userId }).where(eq(schema.articles.id, article.id));
    await tx.update(schema.projects).set({ busyStep: "script", lastError: null }).where(eq(schema.projects.id, projectId));
  });
  await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId, type: "script.requested", payload: { auto: true, durationSec: project.durationSec, tone: project.tone } });
  return projectScriptRequested.create({ projectId, organizationId: ctx.organizationId, requestedBy: ctx.userId, durationSec: project.durationSec, tone: project.tone });
}

/** After `generate-script`: build voice-over, B-roll, music and the timeline from that script version. */
export async function autoAfterScript(ctx: Ctx, projectId: string, scriptId: string) {
  const project = await loadAuto(ctx, projectId);
  if (!project) return null;
  await withOrgContext(ctx, (tx) => tx.update(schema.projects).set({ busyStep: "assets", lastError: null }).where(eq(schema.projects.id, projectId)));
  await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId, type: "assets.requested", payload: { auto: true, scriptId } });
  return projectAssetsRequested.create({ projectId, organizationId: ctx.organizationId, requestedBy: ctx.userId, scriptId });
}

/** After `prepare-assets`: render the freshly built timeline (approval stays a human decision). */
export async function autoAfterAssets(ctx: Ctx, projectId: string, timelineId: string, durationSec: number) {
  const project = await loadAuto(ctx, projectId);
  if (!project) return null;
  const minutes = durationSec / 60;
  try {
    await assertQuota(ctx.userId, "render_minutes");
  } catch (e) {
    return pause(ctx, projectId, "render", e instanceof Error ? e.message : String(e));
  }
  await withOrgContext(ctx, (tx) => tx.update(schema.projects).set({ busyStep: "render", lastError: null }).where(eq(schema.projects.id, projectId)));
  await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId, type: "quota.render_minutes", payload: { minutes: Math.round(minutes * 100) / 100, timelineId } });
  await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId, type: "render.requested", payload: { auto: true, timelineId } });
  return projectRenderRequested.create({ projectId, organizationId: ctx.organizationId, requestedBy: ctx.userId, timelineId });
}
