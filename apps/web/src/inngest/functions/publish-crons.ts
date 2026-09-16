import { cron } from "inngest";
import { eq, lt, or, isNull, and } from "drizzle-orm";
import { inngest } from "../client";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { notifySlack } from "@/lib/notify";
import { channelAccessToken, loadChannelToken, probeToken } from "@/lib/publish/oauth";
import { checkPublication, pullChannelAnalytics, staleProcessing } from "@/lib/publish/service";

/** Publications still processing on the platform: re-check every 10 minutes (docs/PLAN.md §4.10 "Poll processing status"). */
export const pollPublicationsFn = inngest.createFunction(
  { id: "poll-processing-publications", triggers: [cron("*/10 * * * *")], retries: 0, concurrency: [{ limit: 1 }] },
  async ({ step }) => {
    const rows = await step.run("find", () => staleProcessing(5 * 60 * 1000));
    const results: Record<string, string> = {};
    for (const r of rows) {
      results[r.id] = await step.run(`check-${r.id}`, () => checkPublication({ userId: r.createdBy ?? "", organizationId: r.organizationId }, r.id));
    }
    return { checked: rows.length, results };
  },
);

/** Daily analytics pull at 02:30 Asia/Ho_Chi_Minh (19:30 UTC) for every channel with published posts. */
export const pullAnalyticsFn = inngest.createFunction(
  { id: "pull-publication-analytics", triggers: [cron("30 19 * * *")], retries: 0, concurrency: [{ limit: 1 }] },
  async ({ step }) => {
    const channels = await step.run("channels", () => withServiceContext((tx) => tx.select({ id: schema.channels.id, platform: schema.channels.platform }).from(schema.channels).where(eq(schema.channels.enabled, true))));
    const out: Array<{ channelId: string; pulled: number; error?: string }> = [];
    for (const c of channels) out.push(await step.run(`pull-${c.id}`, () => pullChannelAnalytics(c.id)));
    await step.run("log", () => logActivity({ type: "analytics.pulled", payload: { channels: out.length, pulled: out.reduce((a, o) => a + o.pulled, 0), errors: out.filter((o) => o.error).length } }));
    return out;
  },
);

/**
 * Token health every 6 hours (docs/PLAN.md §7 "cron refresh, admin alert on
 * failure"): refresh tokens expiring within 24 h, probe the rest, flag and
 * notify on failure.
 */
export const refreshChannelTokensFn = inngest.createFunction(
  { id: "refresh-channel-tokens", triggers: [cron("15 */6 * * *")], retries: 0, concurrency: [{ limit: 1 }] },
  async ({ step }) => {
    const soon = new Date(Date.now() + 24 * 3600 * 1000);
    const channels = await step.run("channels", () =>
      withServiceContext((tx) =>
        tx
          .select({ id: schema.channels.id, name: schema.channels.name, platform: schema.channels.platform })
          .from(schema.channels)
          .where(and(eq(schema.channels.enabled, true), or(isNull(schema.channels.expiresAt), lt(schema.channels.expiresAt, soon), isNull(schema.channels.lastCheckedAt), lt(schema.channels.lastCheckedAt, new Date(Date.now() - 20 * 3600 * 1000))))),
      ),
    );
    const failures: string[] = [];
    for (const c of channels) {
      const res = await step.run(`refresh-${c.id}`, async () => {
        const channel = await withServiceContext((tx) => tx.query.channels.findFirst({ where: eq(schema.channels.id, c.id) }));
        if (!channel) return { ok: false, error: "missing" as string | null };
        try {
          // 24 h skew: refresh anything expiring within a day, then probe the token.
          const token = channel.expiresAt ? await channelAccessToken(channel, 24 * 3600 * 1000) : await loadChannelToken(channel);
          await probeToken(channel.platform, token, channel.meta);
          await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: true, lastError: null, lastCheckedAt: new Date() }).where(eq(schema.channels.id, c.id)));
          return { ok: true, error: null as string | null };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: false, lastError: message.slice(0, 1000), lastCheckedAt: new Date() }).where(eq(schema.channels.id, c.id)));
          return { ok: false, error: message };
        }
      });
      if (!res.ok) failures.push(`${c.platform} ${c.name}: ${res.error}`);
    }
    if (failures.length) {
      await step.run("alert", async () => {
        await logActivity({ type: "channel.unhealthy", payload: { failures } });
        await notifySlack(`:warning: ${failures.length} channel token(s) need attention:\n${failures.map((f) => `• ${f}`).join("\n")}`);
      });
    }
    return { checked: channels.length, failures };
  },
);
