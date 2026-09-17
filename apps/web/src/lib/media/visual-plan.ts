/**
 * Where a scene's pictures come from, in order of preference. Each tier is
 * only consulted for the shots the earlier tiers could not fill:
 *
 *   1. `article`   – images of the source article itself;
 *   2. `related`   – images from other outlets covering the same story, and
 *      `web_video` – clips from video sites about the same story (yt-dlp);
 *      both share rank 2;
 *   3. `stock`     – free stock video (Pexels / Pixabay) for the scene's terms;
 *   4. `ai`        – generated illustrations (Gemini on Vertex AI), last resort.
 *
 * Pure helpers shared by the build (`prepare-assets`) and the tests.
 */
export const VISUAL_TIERS = ["article", "related", "web_video", "stock", "ai"] as const;
export type VisualTier = (typeof VISUAL_TIERS)[number];

/** Same-story material from other outlets and from video sites rank equally. */
export const TIER_RANK: Record<VisualTier, number> = { article: 0, related: 1, web_video: 1, stock: 2, ai: 3 };

export const tierRank = (t: VisualTier) => TIER_RANK[t];

/** Stable sort by tier so a scene shows its most authentic picture first. */
export function orderByTier<T extends { tier: VisualTier }>(items: T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => tierRank(a.it.tier) - tierRank(b.it.tier) || a.i - b.i).map(({ it }) => it);
}

/** Shots still missing per scene after `have` pictures were placed. */
export function shortfall(need: Record<string, number>, have: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(need).map(([id, n]) => [id, Math.max(0, n - (have[id] ?? 0))]));
}

export const total = (rec: Record<string, number>) => Object.values(rec).reduce((a, n) => a + n, 0);

/**
 * Place pool items into scenes: ranked `picks` (pool indexes, best first) win,
 * then whatever is left is handed out in pool order. A pool item may be used
 * up to `capacity[i]` times (default 1) – a web video contributes one shot
 * per 5 s segment – and consecutive uses of the same item are numbered by
 * `segment` so no two shots show the same footage. No scene gets more than it wants.
 */
export type Placement = { index: number; segment: number };

export function allocate(
  wanting: Array<{ id: string; want: number }>,
  poolSize: number,
  picks: Record<string, number[]>,
  capacity: number[] = [],
): { perScene: Record<string, Placement[]>; used: number } {
  const usedCount: number[] = Array.from({ length: poolSize }, () => 0);
  const cap = (i: number) => Math.max(0, Math.floor(capacity[i] ?? 1));
  const take = (i: number) => {
    const p: Placement = { index: i, segment: usedCount[i] };
    usedCount[i] += 1;
    return p;
  };
  const perScene: Record<string, Placement[]> = {};
  for (const w of wanting) {
    const chosen: Placement[] = [];
    for (const i of picks[w.id] ?? []) {
      if (!Number.isInteger(i) || i < 0 || i >= poolSize) continue;
      // A ranked pick of a multi-segment item fills consecutive shots of this scene.
      while (chosen.length < w.want && usedCount[i] < cap(i)) chosen.push(take(i));
    }
    perScene[w.id] = chosen;
  }
  for (const w of wanting) {
    const chosen = perScene[w.id];
    for (let i = 0; i < poolSize && chosen.length < w.want; i++) while (chosen.length < w.want && usedCount[i] < cap(i)) chosen.push(take(i));
  }
  return { perScene, used: usedCount.filter((n) => n > 0).length };
}

/**
 * Split a shared budget (e.g. the user's remaining AI-image quota) across
 * scenes in order, each scene taking at most what it still needs.
 */
export function splitBudget(wanting: Array<{ id: string; want: number }>, budget: number): Record<string, number> {
  const out: Record<string, number> = {};
  let left = Math.max(0, Math.floor(budget));
  for (const w of wanting) {
    const n = Math.min(Math.max(0, w.want), left);
    out[w.id] = n;
    left -= n;
  }
  return out;
}

export const SHOT_SEC = 5;

/**
 * How much of a web video is worth fetching: skip a short lead-in on longer
 * videos (title cards, presenter intro), then up to `maxSegments` shots of
 * `SHOT_SEC` each. `capacity` 0 means the video is too short to use.
 */
export function videoSegments(durationSec: number | null, maxSegments = 4): { startSec: number; endSec: number; capacity: number } {
  const d = durationSec ?? 0;
  const startSec = d >= 60 ? 8 : d >= 30 ? 3 : 0;
  const capacity = Math.max(0, Math.min(maxSegments, Math.floor((d - startSec) / SHOT_SEC)));
  return { startSec, endSec: startSec + capacity * SHOT_SEC, capacity };
}

/**
 * A web video the build wanted but the media Lambda could not download
 * (YouTube bot-checks datacenter IPs). The editor can record it in the
 * user's own browser instead (`tab-capture.ts`), on the user's connection.
 */
export type PendingCapture = {
  videoId: string;
  url: string;
  title: string;
  uploader: string | null;
  thumbnailUrl: string | null;
  /** Section the build planned to use: `segments` shots of SHOT_SEC from `startSec`. */
  startSec: number;
  segments: number;
  /** Where the segments were meant to go, in placement order. */
  scenes: Array<{ sceneId: string; segments: number }>;
  error: string;
};

/** 11-character id of a YouTube watch / shorts / embed / youtu.be URL, else null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    const id = host === "youtu.be" ? u.pathname.slice(1).split("/")[0] : host === "youtube.com" || host === "youtube-nocookie.com" ? (u.pathname === "/watch" ? u.searchParams.get("v") : (/^\/(?:shorts|embed|live)\/([^/?]+)/.exec(u.pathname)?.[1] ?? null)) : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
