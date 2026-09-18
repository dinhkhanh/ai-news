import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { logActivity } from "@/lib/activity";
import { busyStep, directRunAllowed, startProgress, STEP_LABEL, type DirectStep } from "@/lib/project-state";
import type { Workspace } from "@/lib/workspace";
import { failFetch, fetchPipeline, type FetchRequest } from "./fetch";
import { failScript, scriptPipeline, type ScriptRequest } from "./script";
import { directSteps } from "./steps";

type Ctx = Pick<Workspace, "userId" | "organizationId">;

/**
 * Direct runs: the short pipeline steps (`DIRECT_STEPS`) executed inside the app, from a server action's
 * `after()`, when the queue (Inngest) has not picked a requested step up after `QUEUE_SLOW_MS` or the step went
 * stale. Same body as the Inngest function, no retries. The queued event stays at Inngest; when it is finally
 * delivered, the function's first step sees the newer result (or this run's `direct` progress) and ends.
 *
 * `claimDirectRun` is a compare-and-set on `busy_progress.at`: of two people pressing the button, one wins.
 * `allowIdle`: also start from an idle project (a direct re-fetch after a failed one; nothing is waiting then).
 */
export async function claimDirectRun(ctx: Ctx, projectId: string, step: DirectStep, label: string, opts: { allowIdle?: boolean } = {}) {
  return withOrgContext(ctx, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    if (!project) throw new Error("Project not found in this workspace");
    const running = busyStep(project);
    const idle = !running && project.busyStep !== step;
    if (!(idle && opts.allowIdle) && !directRunAllowed(project, step)) {
      throw new Error(running ? `Please wait: ${STEP_LABEL[running] ?? running} is running or has only just been queued` : "Nothing is waiting in the queue for this step");
    }
    const claimed = await tx
      .update(schema.projects)
      .set({ busyStep: step, busyProgress: { ...startProgress(label), direct: true }, lastError: null })
      .where(and(eq(schema.projects.id, projectId), sql`coalesce(${schema.projects.busyProgress}->>'at', '') = ${project.busyProgress?.at ?? ""}`))
      .returning({ id: schema.projects.id });
    if (!claimed.length) throw new Error("This step has just been started by someone else");
    return project;
  });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Auto mode queued the next step (`busy_step` is set) but the event could not even be sent: release the project. */
async function releaseAfterSendFailure(data: { projectId: string; organizationId: string; requestedBy: string }, e: unknown) {
  const message = `Tự động dừng: không gửi được bước tiếp theo vào hàng đợi (${errMsg(e)})`;
  await withOrgContext({ userId: data.requestedBy, organizationId: data.organizationId }, (tx) =>
    tx.update(schema.projects).set({ busyStep: null, busyProgress: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, data.projectId)),
  ).catch((err) => console.error("[direct] release failed", err));
  await logActivity({ actorId: data.requestedBy, organizationId: data.organizationId, projectId: data.projectId, type: "auto.paused", payload: { reason: "event send failed", error: errMsg(e).slice(0, 500) } });
}

/** Never throws: runs inside `after()`, where nobody is left to catch. A manual paste (`manual`) ignores `only`. */
export async function runFetchDirect(data: FetchRequest) {
  let next: Awaited<ReturnType<typeof fetchPipeline>>["next"] = null;
  try {
    ({ next } = await fetchPipeline({ ...data, only: true, sentAt: undefined }, directSteps));
  } catch (e) {
    console.error("[direct] fetch failed", e);
    await failFetch(data, errMsg(e), true).catch((err) => console.error("[direct] failFetch failed", err));
    return;
  }
  if (next) await inngest.send(next).catch((e) => releaseAfterSendFailure(data, e));
}

export async function runScriptDirect(data: ScriptRequest) {
  let next: Awaited<ReturnType<typeof scriptPipeline>>["next"] = null;
  try {
    ({ next } = await scriptPipeline({ ...data, sentAt: undefined }, directSteps));
  } catch (e) {
    console.error("[direct] script failed", e);
    await failScript(data, errMsg(e), true).catch((err) => console.error("[direct] failScript failed", err));
    return;
  }
  if (next) await inngest.send(next).catch((e) => releaseAfterSendFailure(data, e));
}
