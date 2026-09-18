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

/** Tiers a political story may not use: only real pictures of the story itself, never stock footage or AI stills. */
export const POLITICAL_EXCLUDED_TIERS: readonly VisualTier[] = ["stock", "ai"];
export const tierAllowed = (t: VisualTier, political: boolean) => !political || !POLITICAL_EXCLUDED_TIERS.includes(t);

/** Most tier-2 searches (other outlets' images / web video) one build runs, the story query included. */
export const MAX_TIER2_QUERIES = 7;

/**
 * What tier 2 searches for: "what you hear is what you see". Every scene that
 * still needs pictures searches for what its own voice-over names (its first
 * `newsTerms`: the person, company, place, event…), and the story as a whole
 * is searched once by the article title as the fallback for the rest. A query
 * two scenes share runs once and is credited to both. Scenes come first, in
 * order, so the cap drops the story query last.
 */
export type SceneQuery = { query: string; sceneIds: string[] };

export function tier2Queries(scenes: Array<{ id: string; kind: "hook" | "body" | "cta"; newsTerms?: string[] }>, need: Record<string, number>, articleTitle: string): SceneQuery[] {
  const norm = (q: string) => q.trim().replace(/\s+/g, " ");
  const byKey = new Map<string, SceneQuery>();
  const add = (query: string, sceneId: string | null) => {
    const q = norm(query);
    if (!q) return;
    const k = q.toLowerCase();
    const cur = byKey.get(k) ?? { query: q, sceneIds: [] };
    if (sceneId && !cur.sceneIds.includes(sceneId)) cur.sceneIds.push(sceneId);
    byKey.set(k, cur);
  };
  for (const sc of scenes) if (sc.kind !== "cta" && (need[sc.id] ?? 0) > 0) add(sc.newsTerms?.[0] ?? "", sc.id);
  const perScene = [...byKey.values()].slice(0, MAX_TIER2_QUERIES - 1);
  const title = norm(articleTitle);
  const story = title && !perScene.some((q) => q.query.toLowerCase() === title.toLowerCase()) ? [{ query: title, sceneIds: [] }] : [];
  return [...perScene, ...story];
}

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
 * `allocate` with a veto: `accept(index, sceneId)` is the face guard's verdict
 * for that picture in that scene (`framing.ts`). A vetoed item leaves the pool
 * for the whole video and the placement is redone, so another candidate – or
 * a later tier – takes the shot. Converges because every round removes items.
 */
export function allocateChecked(
  wanting: Array<{ id: string; want: number }>,
  poolSize: number,
  picks: Record<string, number[]>,
  capacity: number[],
  accept: (index: number, sceneId: string) => boolean,
): { perScene: Record<string, Placement[]>; used: number; rejected: Array<{ index: number; sceneId: string }> } {
  const cap = Array.from({ length: poolSize }, (_, i) => capacity[i] ?? 1);
  const rejected: Array<{ index: number; sceneId: string }> = [];
  for (;;) {
    const a = allocate(wanting, poolSize, picks, cap);
    const bad = Object.entries(a.perScene).flatMap(([sceneId, list]) => list.filter((p) => cap[p.index] > 0 && !accept(p.index, sceneId)).map((p) => ({ index: p.index, sceneId })));
    if (bad.length === 0) return { ...a, rejected };
    for (const b of bad) {
      if (cap[b.index] > 0) rejected.push(b);
      cap[b.index] = 0;
    }
  }
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
  /** Pasted by hand in the inspector for one shot (`importWebVideo`): the recording replaces that shot as one clip instead of filling planned segments. */
  manual?: { sceneId: string; shot: number };
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

/** Longest section of a web video the editor fetches by hand (the NAS API refuses more than 120 s; a shot needs far less). */
export const MAX_MANUAL_SECTION_SEC = 60;
/** Section fetched when the editor pastes a video page without an end time. */
export const DEFAULT_MANUAL_SECTION_SEC = 20;

/**
 * Video pages the editor may paste instead of a direct file link: YouTube
 * (watch / shorts / youtu.be), TikTok, Facebook watch / reels / videos,
 * fb.watch, Vimeo, Dailymotion. Mirrors `VIDEO_PAGE` of the media Lambda's
 * `server-validate.ts`, which insists on https (`webVideoPageUrl` upgrades).
 */
export const WEB_VIDEO_PAGE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|shorts\/)|youtu\.be\/|tiktok\.com\/@[^/]+\/video\/|facebook\.com\/(?:watch|reel|[^/]+\/videos)|fb\.watch\/|vimeo\.com\/\d|dailymotion\.com\/video\/)/i;

/** The pasted text as the video page URL the downloader accepts (https, trimmed), or null when it is not a supported video page. */
export function webVideoPageUrl(text: string): string | null {
  const u = text.trim();
  if (!WEB_VIDEO_PAGE.test(u)) return null;
  return u.replace(/^http:\/\//i, "https://");
}

/**
 * "20", "0:20", "1:02", "1:02:03" or "20.5" → seconds; null when unreadable or
 * negative. Blank is null too, so callers can apply a default.
 */
export function parseTimecode(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n >= 60)) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

/** Seconds → "m:ss" (or "h:mm:ss"), whole seconds. */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/**
 * The section of a web video to fetch: `[start, end)` from the user's
 * timecodes, a `DEFAULT_MANUAL_SECTION_SEC` window when there is no end, cut
 * to the video's length when known and to `MAX_MANUAL_SECTION_SEC`. Returns
 * an error message (Vietnamese, for the editor) when the range makes no sense.
 */
export function manualSection(input: { startSec: number | null; endSec: number | null; durationSec: number | null }): { ok: true; startSec: number; endSec: number } | { ok: false; error: string } {
  const start = Math.max(0, input.startSec ?? 0);
  let end = input.endSec ?? start + DEFAULT_MANUAL_SECTION_SEC;
  if (input.durationSec != null && input.durationSec > 0) {
    if (start >= input.durationSec) return { ok: false, error: `Video chỉ dài ${formatTimecode(input.durationSec)}` };
    end = Math.min(end, input.durationSec);
  }
  if (end <= start) return { ok: false, error: "Mốc kết thúc phải sau mốc bắt đầu" };
  if (end - start < 1) return { ok: false, error: "Đoạn cắt phải dài ít nhất 1 giây" };
  if (end - start > MAX_MANUAL_SECTION_SEC) return { ok: false, error: `Đoạn cắt tối đa ${MAX_MANUAL_SECTION_SEC} giây (${formatTimecode(start)} → ${formatTimecode(start + MAX_MANUAL_SECTION_SEC)})` };
  return { ok: true, startSec: Math.round(start * 10) / 10, endSec: Math.round(end * 10) / 10 };
}
