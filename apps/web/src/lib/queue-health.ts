import "server-only";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { notifySlack } from "@/lib/notify";
import { QUEUE_SLOW_MS, STEP_LABEL } from "@/lib/project-state";

/**
 * Health of the background queue (Inngest), judged from our side: a project whose requested step was never
 * started (`busy_progress.at` = `startedAt`, see `queuedForMs`) for longer than `QUEUE_SLOW_MS` is the symptom
 * users see as a project stuck on "Đang xếp hàng…". Inngest's own status page is shown next to it.
 * Older than `LOOKBACK_MS` is an abandoned project, not an outage.
 */
const LOOKBACK_MS = 6 * 3600 * 1000;
/** One alert per outage, not one per watchdog tick. */
const ALERT_EVERY_MS = 3 * 3600 * 1000;
export const QUEUE_STALLED_EVENT = "queue.stalled";

export type StalledStep = { projectId: string; organizationId: string; step: string; since: string };

export async function findStalledQueue(now = Date.now()): Promise<StalledStep[]> {
  const p = schema.projects;
  const startedAt = sql<string>`${p.busyProgress}->>'startedAt'`;
  const rows = await withServiceContext((tx) =>
    tx
      .select({ projectId: p.id, organizationId: p.organizationId, step: p.busyStep, since: startedAt })
      .from(p)
      .where(
        and(
          sql`${p.busyStep} is not null`,
          sql`${p.busyProgress}->>'at' = ${startedAt}`,
          sql`coalesce((${p.busyProgress}->>'direct')::boolean, false) = false`,
          sql`(${startedAt})::timestamptz < ${new Date(now - QUEUE_SLOW_MS).toISOString()}::timestamptz`,
          sql`(${startedAt})::timestamptz > ${new Date(now - LOOKBACK_MS).toISOString()}::timestamptz`,
        ),
      )
      .orderBy(sql`(${startedAt})::timestamptz`)
      .limit(50),
  );
  return rows.map((r) => ({ ...r, step: r.step ?? "" }));
}

export type InngestStatus = { indicator: string; description: string; incidents: Array<{ name: string; status: string; since: string }> };

/** status.inngest.com (Statuspage summary). Null when it cannot be read: that says nothing about Inngest itself. */
export async function inngestStatus(): Promise<InngestStatus | null> {
  try {
    const res = await fetch("https://status.inngest.com/api/v2/summary.json", { signal: AbortSignal.timeout(4000), cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { status?: { indicator?: string; description?: string }; incidents?: Array<{ name?: string; status?: string; created_at?: string }> };
    return {
      indicator: json.status?.indicator ?? "unknown",
      description: json.status?.description ?? "unknown",
      incidents: (json.incidents ?? []).map((i) => ({ name: i.name ?? "", status: i.status ?? "", since: i.created_at ?? "" })),
    };
  } catch {
    return null;
  }
}

/**
 * Watchdog tick (cron job `queue-watchdog`, which must not itself run on Inngest): when steps are stuck in the
 * queue, write one `queue.stalled` activity row and one Slack message per `ALERT_EVERY_MS`.
 */
export async function checkQueue() {
  const stalled = await findStalledQueue();
  if (!stalled.length) return { stalled: 0, alerted: false };
  const [recent] = await withServiceContext((tx) =>
    tx
      .select({ id: schema.activityEvents.id })
      .from(schema.activityEvents)
      .where(and(eq(schema.activityEvents.type, QUEUE_STALLED_EVENT), gt(schema.activityEvents.createdAt, new Date(Date.now() - ALERT_EVERY_MS))))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(1),
  );
  if (recent) return { stalled: stalled.length, alerted: false };
  const status = await inngestStatus();
  await logActivity({ type: QUEUE_STALLED_EVENT, payload: { count: stalled.length, oldestSince: stalled[0].since, steps: stalled.slice(0, 10), inngest: status } });
  const minutes = Math.round((Date.now() - Date.parse(stalled[0].since)) / 60000);
  const incident = status?.incidents[0];
  await notifySlack(
    `:hourglass: ${stalled.length} pipeline step(s) are waiting for the queue, the oldest for ${minutes} min (${stalled
      .slice(0, 5)
      .map((s) => STEP_LABEL[s.step] ?? s.step)
      .join(", ")}). Inngest status: ${status ? status.description : "unreadable"}${incident ? ` – ${incident.name} (${incident.status})` : ""}. Fetch and script can be run directly from the project page.`,
  );
  return { stalled: stalled.length, alerted: true };
}
