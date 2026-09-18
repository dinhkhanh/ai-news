import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { notifySlack } from "@/lib/notify";
import { channelAccessToken, loadChannelToken, probeToken } from "@/lib/publish/oauth";
import { checkPublication, pullChannelAnalytics, staleProcessing } from "@/lib/publish/service";
import { checkQueue } from "@/lib/queue-health";

/**
 * The recurring jobs as plain functions, so the scheduler is a deployment choice: `GET|POST /api/cron/<job>`
 * (any HTTP scheduler: Supabase pg_cron, Vercel Cron on a Pro plan, a cron on the NAS) or the Inngest crons in
 * `src/inngest/functions/publish-crons.ts`. Every job is safe to run twice and one failing item never stops
 * the rest. Schedules are in UTC.
 */

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Publications still processing on the platform: re-check every 10 minutes (docs/PLAN.md §4.10 "Poll processing status"). */
export async function pollPublications() {
  const rows = await staleProcessing(5 * 60 * 1000);
  const results: Record<string, string> = {};
  for (const r of rows) {
    results[r.id] = await checkPublication({ userId: r.createdBy ?? "", organizationId: r.organizationId }, r.id).catch((e) => `error: ${errMsg(e).slice(0, 200)}`);
  }
  return { checked: rows.length, results };
}

/** Daily analytics pull at 02:30 Asia/Ho_Chi_Minh (19:30 UTC) for every channel with published posts. */
export async function pullAnalytics() {
  const channels = await withServiceContext((tx) => tx.select({ id: schema.channels.id, platform: schema.channels.platform }).from(schema.channels).where(eq(schema.channels.enabled, true)));
  const out: Array<{ channelId: string; pulled: number; error?: string }> = [];
  for (const c of channels) out.push(await pullChannelAnalytics(c.id).catch((e) => ({ channelId: c.id, pulled: 0, error: errMsg(e).slice(0, 200) })));
  await logActivity({ type: "analytics.pulled", payload: { channels: out.length, pulled: out.reduce((a, o) => a + o.pulled, 0), errors: out.filter((o) => o.error).length } });
  return out;
}

/**
 * Token health every 6 hours (docs/PLAN.md §7 "cron refresh, admin alert on
 * failure"): refresh tokens expiring within 24 h, probe the rest, flag and
 * notify on failure.
 */
export async function refreshChannelTokens() {
  const soon = new Date(Date.now() + 24 * 3600 * 1000);
  const channels = await withServiceContext((tx) =>
    tx
      .select({ id: schema.channels.id, name: schema.channels.name, platform: schema.channels.platform })
      .from(schema.channels)
      .where(and(eq(schema.channels.enabled, true), or(isNull(schema.channels.expiresAt), lt(schema.channels.expiresAt, soon), isNull(schema.channels.lastCheckedAt), lt(schema.channels.lastCheckedAt, new Date(Date.now() - 20 * 3600 * 1000))))),
  );
  const failures: string[] = [];
  for (const c of channels) {
    const channel = await withServiceContext((tx) => tx.query.channels.findFirst({ where: eq(schema.channels.id, c.id) }));
    if (!channel) {
      failures.push(`${c.platform} ${c.name}: missing`);
      continue;
    }
    try {
      // 24 h skew: refresh anything expiring within a day, then probe the token.
      const token = channel.expiresAt ? await channelAccessToken(channel, 24 * 3600 * 1000) : await loadChannelToken(channel);
      await probeToken(channel.platform, token, channel.meta);
      await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: true, lastError: null, lastCheckedAt: new Date() }).where(eq(schema.channels.id, c.id)));
    } catch (err) {
      const message = errMsg(err);
      await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: false, lastError: message.slice(0, 1000), lastCheckedAt: new Date() }).where(eq(schema.channels.id, c.id)));
      failures.push(`${c.platform} ${c.name}: ${message}`);
    }
  }
  if (failures.length) {
    await logActivity({ type: "channel.unhealthy", payload: { failures } });
    await notifySlack(`:warning: ${failures.length} channel token(s) need attention:\n${failures.map((f) => `• ${f}`).join("\n")}`);
  }
  return { checked: channels.length, failures };
}

/** `schedule` documents the intended cadence (UTC); the scheduler itself lives outside the app (infra/supabase/cron.sql). */
export const CRON_JOBS = {
  "poll-publications": { schedule: "*/10 * * * *", run: pollPublications },
  "pull-analytics": { schedule: "30 19 * * *", run: pullAnalytics },
  "refresh-channel-tokens": { schedule: "15 */6 * * *", run: refreshChannelTokens },
  /** Only useful on a scheduler that is not Inngest: it watches Inngest. */
  "queue-watchdog": { schedule: "*/5 * * * *", run: checkQueue },
} as const satisfies Record<string, { schedule: string; run: () => Promise<unknown> }>;

export type CronJob = keyof typeof CRON_JOBS;
export const isCronJob = (name: string): name is CronJob => Object.hasOwn(CRON_JOBS, name);
