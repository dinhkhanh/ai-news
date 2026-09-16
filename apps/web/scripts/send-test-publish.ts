/**
 * Phase 5 acceptance test without the browser: creates a publication row for
 * the approved render of a project on a connected channel, sends
 * publication/requested and follows the row until it is published (or fails),
 * then prints the platform post id / URL, activity, YouTube quota units and
 * (with --analytics) pulls analytics for the channel.
 *
 *   INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-publish.ts <projectId> <channelId> [--privacy private|unlisted|SELF_ONLY] [--schedule 2m] [--analytics]
 * Requires `INNGEST_DEV=1 pnpm dev`, the Inngest dev server, a channel connected in /admin/channels
 * and the platform flag enabled in /admin/integrations.
 */
import postgres from "postgres";
import { Inngest } from "inngest";
import { publicationRequested } from "../src/inngest/events";
import { buildMetadata, idempotencyKey, PLATFORM_SPEC, type Platform } from "../src/lib/publish/platforms";

const sql = postgres(process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!, { prepare: false, max: 1 });
const inngest = new Inngest({ id: "ai-news" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const [projectId, channelId] = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== arg("--privacy") && a !== arg("--schedule"));
  if (!projectId || !channelId) throw new Error("usage: send-test-publish.ts <projectId> <channelId> [--privacy …] [--schedule 2m] [--analytics]");
  const [p] = await sql<{ organization_id: string; owner_id: string; state: string; title: string | null; url: string; language: "vi" | "en"; approved_timeline_id: string | null; ai_disclosure: boolean }[]>`select organization_id, owner_id, state, title, url, language, approved_timeline_id, ai_disclosure from projects where id = ${projectId}`;
  if (!p) throw new Error("project not found");
  const [ch] = await sql<{ id: string; platform: Platform; name: string; organization_id: string; enabled: boolean; vault_ref: string | null }[]>`select id, platform, name, organization_id, enabled, vault_ref from channels where id = ${channelId}`;
  if (!ch) throw new Error("channel not found");
  if (ch.organization_id !== p.organization_id) throw new Error("channel belongs to another workspace");
  if (!p.approved_timeline_id) throw new Error(`project has no approved timeline (state=${p.state}); approve + render first`);
  const [r] = await sql<{ id: string; timeline_version: number; duration_sec: string; output_path: string }[]>`select id, timeline_version, duration_sec, output_path from renders where project_id = ${projectId} and timeline_id = ${p.approved_timeline_id} and status = 'done' order by created_at desc limit 1`;
  if (!r) throw new Error("no finished render of the approved timeline");
  const [flag] = await sql<{ enabled: boolean }[]>`select enabled from feature_flags where key = ${PLATFORM_SPEC[ch.platform].flag}`;
  console.log(`project "${p.title}" state=${p.state} render v${r.timeline_version} ${Number(r.duration_sec).toFixed(1)}s → ${PLATFORM_SPEC[ch.platform].label} "${ch.name}" (enabled=${ch.enabled} token=${Boolean(ch.vault_ref)} flag=${flag?.enabled ?? false})`);

  const [sc] = await sql<{ scenes_json: { metadata?: Record<string, { title: string; description: string; hashtags: string[] }> } }[]>`select scenes_json from scripts where project_id = ${projectId} order by version desc limit 1`;
  const [art] = await sql<{ site_name: string | null; canonical_url: string }[]>`select site_name, canonical_url from articles where project_id = ${projectId} order by created_at desc limit 1`;
  const meta = buildMetadata({ platform: ch.platform, meta: sc?.scenes_json.metadata?.[PLATFORM_SPEC[ch.platform].metadataKey] ?? null, fallbackTitle: p.title ?? p.url, language: p.language, source: { siteName: art?.site_name ?? null, url: art?.canonical_url ?? p.url }, aiDisclosure: p.ai_disclosure });
  const privacy = arg("--privacy") ?? (ch.platform === "tiktok" ? "SELF_ONLY" : ch.platform === "youtube" ? "private" : "public");
  const schedule = arg("--schedule");
  const scheduledAt = schedule ? new Date(Date.now() + Number(schedule.replace(/m$/, "")) * 60_000) : new Date();
  const [{ n }] = await sql<{ n: string }[]>`select coalesce(max(attempts), 0) as n from publications where render_id = ${r.id} and channel_id = ${channelId}`;
  const attempt = Number(n) + 1;
  const [pub] = await sql<{ id: string }[]>`insert into publications (organization_id, project_id, channel_id, render_id, platform, idempotency_key, attempts, status, metadata, privacy, ai_disclosure, scheduled_at, created_by)
    values (${p.organization_id}, ${projectId}, ${channelId}, ${r.id}, ${ch.platform}, ${idempotencyKey(r.id, channelId, attempt)}, ${attempt}, 'scheduled', ${sql.json(meta as never)}, ${privacy}, ${p.ai_disclosure}, ${scheduledAt}, ${p.owner_id}) returning id`;
  console.log(`publication ${pub.id} attempt ${attempt} privacy=${privacy} scheduled=${scheduledAt.toISOString()} title="${meta.title.slice(0, 60)}"`);
  const evt = await inngest.send(publicationRequested.create({ publicationId: pub.id, organizationId: p.organization_id, requestedBy: p.owner_id, channelId }));
  console.log(`sent ${evt.ids[0]}`);

  const started = Date.now();
  for (;;) {
    await sleep(5000);
    const [x] = await sql<{ status: string; platform_post_id: string | null; platform_url: string | null; error: string | null; metadata: Record<string, unknown> }[]>`select status, platform_post_id, platform_url, error, metadata from publications where id = ${pub.id}`;
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`${elapsed}s status=${x.status}${x.platform_post_id ? ` post=${x.platform_post_id}` : ""}${x.error ? ` error=${x.error.slice(0, 160)}` : ""}`);
    if (x.status === "published" || x.status === "failed" || x.status === "cancelled") {
      console.log("url:", x.platform_url, "\nhandles:", JSON.stringify(x.metadata.handles ?? null), "\nsent:", JSON.stringify(x.metadata.sent ?? null)?.slice(0, 400));
      if (x.status !== "published") throw new Error(x.error ?? x.status);
      break;
    }
    if (elapsed > 1200) throw new Error("timed out (still processing; the 10-minute cron keeps polling)");
  }
  const [proj] = await sql<{ state: string }[]>`select state from projects where id = ${projectId}`;
  console.log("project state:", proj.state);
  const events = await sql<{ type: string; payload: Record<string, unknown> }[]>`select type, payload from activity_events where project_id = ${projectId} and type like 'publication.%' order by id desc limit 5`;
  console.log("activity:", events.map((e) => e.type).join(" ← "));
  const [yt] = await sql<{ units: string | null }[]>`select sum(units) as units from usage_costs where provider = 'youtube_api' and created_at > now() - interval '30 minutes'`;
  if (yt.units) console.log("YouTube quota units (30 min):", yt.units);
  if (process.argv.includes("--analytics")) {
    const { pullChannelAnalytics } = await import("../src/lib/publish/service");
    console.log("analytics:", await pullChannelAnalytics(channelId, 1));
    const [a] = await sql<{ analytics_json: unknown }[]>`select analytics_json from publications where id = ${pub.id}`;
    console.log(JSON.stringify(a.analytics_json));
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
