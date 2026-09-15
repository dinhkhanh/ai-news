import "server-only";
import { arrayOverlaps, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordUsageCost } from "@/lib/activity";
import { readSecret } from "@/lib/vault";
import { downloadToR2 } from "./stock";

/**
 * Background music (docs/PLAN.md §4.5): Mubert by mood + duration when the
 * integration is enabled, otherwise a track from the admin-curated library
 * with matching mood tags. Returns null when nothing is available (VO only).
 */
export type MusicPick = { source: "mubert" | "library"; key: string; title: string; licence: string; attribution: string; costUsd: number };

/** Script tone → mood vocabulary shared by the library tags and the Mubert prompt. */
export const TONE_MOODS: Record<string, { tags: string[]; prompt: string; intensity: "low" | "medium" | "high" }> = {
  news: { tags: ["news", "neutral", "corporate", "minimal"], prompt: "neutral broadcast news bed, minimal electronic pulse, no melody hooks", intensity: "low" },
  explainer: { tags: ["calm", "minimal", "ambient", "explainer"], prompt: "calm minimal ambient explainer background, soft piano and pads", intensity: "low" },
  urgent: { tags: ["tense", "driving", "breaking", "cinematic"], prompt: "tense driving breaking-news underscore, percussive, cinematic", intensity: "medium" },
  casual: { tags: ["upbeat", "light", "friendly", "pop"], prompt: "light upbeat friendly background, acoustic pop, positive", intensity: "medium" },
};

export async function pickLibraryTrack(tone: string, minDurationSec: number): Promise<MusicPick | null> {
  const moods = TONE_MOODS[tone]?.tags ?? TONE_MOODS.news.tags;
  let rows = await db.select().from(schema.musicLibrary).where(arrayOverlaps(schema.musicLibrary.moodTags, moods));
  if (rows.length === 0) rows = await db.select().from(schema.musicLibrary);
  const long = rows.filter((r) => Number(r.durationSec ?? 0) >= minDurationSec);
  const pool = long.length ? long : rows; // shorter tracks loop in the mix
  if (pool.length === 0) return null;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return { source: "library", key: t.r2Path, title: t.title, licence: t.licence, attribution: `Nhạc: ${t.title}`, costUsd: 0 };
}

type MubertTrack = { id: string; generations?: Array<{ status: string; url?: string | null; format?: string }> };

/**
 * Mubert API v3 (music-api.mubert.com). The integration secret is
 * "CUSTOMER_ID:ACCESS_TOKEN". Generation is async: create, then poll.
 */
export async function generateMubertTrack(
  opts: { tone: string; durationSec: number; r2Key: string },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<MusicPick | null> {
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, "mubert") });
  if (!row?.enabled || !row.vaultRef) return null;
  const secret = await readSecret(row.vaultRef);
  const [customerId, accessToken] = (secret ?? "").split(":");
  if (!customerId || !accessToken) throw new Error("Mubert secret must be CUSTOMER_ID:ACCESS_TOKEN");
  const headers = { "customer-id": customerId, "access-token": accessToken, "Content-Type": "application/json" };
  const mood = TONE_MOODS[opts.tone] ?? TONE_MOODS.news;
  const duration = Math.min(1500, Math.max(15, Math.ceil(opts.durationSec) + 3));
  const create = await fetch("https://music-api.mubert.com/api/v3/public/tracks", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: mood.prompt, duration, bitrate: 192, format: "mp3", intensity: mood.intensity, mode: "track" }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = (await create.json().catch(() => ({}))) as { data?: MubertTrack; error?: { message?: string } };
  if (!create.ok || !created.data?.id) throw new Error(`Mubert create failed: HTTP ${create.status} ${created.error?.message ?? ""}`);
  const id = created.data.id;
  let url: string | null = null;
  for (let i = 0; i < 24 && !url; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(`https://music-api.mubert.com/api/v3/public/tracks/${id}`, { headers, signal: AbortSignal.timeout(20_000) });
    const json = (await poll.json().catch(() => ({}))) as { data?: MubertTrack };
    const g = json.data?.generations?.find((x) => x.status === "done" && x.url);
    if (g?.url) url = g.url;
    if (json.data?.generations?.some((x) => x.status === "error" || x.status === "failed")) throw new Error("Mubert generation failed");
  }
  if (!url) throw new Error("Mubert generation timed out");
  await downloadToR2(url, opts.r2Key, "audio/mpeg");
  await recordUsageCost({ provider: "mubert", resource: "track", units: duration, unitType: "seconds", costUsd: 0, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { trackId: id, tone: opts.tone, note: "billed by Mubert plan; cost not itemised" } });
  return { source: "mubert", key: opts.r2Key, title: `Mubert ${id.slice(0, 8)}`, licence: "Mubert API licence", attribution: "Nhạc: Mubert", costUsd: 0 };
}

export async function pickMusic(opts: { tone: string; durationSec: number; r2Key: string }, ctx: { userId: string; organizationId: string; projectId: string }): Promise<{ pick: MusicPick | null; error: string | null }> {
  try {
    const m = await generateMubertTrack(opts, ctx);
    if (m) return { pick: m, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn("[music] Mubert failed, falling back to library:", error);
    const lib = await pickLibraryTrack(opts.tone, opts.durationSec);
    return { pick: lib, error };
  }
  return { pick: await pickLibraryTrack(opts.tone, opts.durationSec), error: null };
}
