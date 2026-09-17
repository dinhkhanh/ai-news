import type { WebVideoCandidate } from "./types.js";

/** Subset of a yt-dlp info dict (`--dump-single-json`, flat or full). */
export type YtdlpEntry = {
  id?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  title?: string;
  duration?: number | null;
  thumbnail?: string;
  thumbnails?: Array<{ url: string; width?: number; height?: number }>;
  uploader?: string;
  channel?: string;
  extractor_key?: string;
  ie_key?: string;
  extractor?: string;
  view_count?: number | null;
  upload_date?: string;
  width?: number;
  height?: number;
  live_status?: string;
  availability?: string;
  _type?: string;
  entries?: YtdlpEntry[];
};

const SITE: Record<string, string> = { youtube: "YouTube", youtubetab: "YouTube", tiktok: "TikTok", facebook: "Facebook", vimeo: "Vimeo", dailymotion: "Dailymotion" };

/** Normalise one yt-dlp entry into a candidate; null for lives, playlists and entries without a page URL. */
export function toCandidate(e: YtdlpEntry): WebVideoCandidate | null {
  if (!e || e._type === "playlist" || e.entries) return null;
  const url = e.webpage_url ?? e.original_url ?? e.url;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (e.live_status && e.live_status !== "not_live" && e.live_status !== "was_live") return null;
  if (e.availability && !["public", "unlisted"].includes(e.availability)) return null;
  const extractor = (e.extractor_key ?? e.ie_key ?? e.extractor ?? "").toLowerCase().replace(/:.*$/, "");
  const thumbs = (e.thumbnails ?? []).filter((t) => t.url);
  const best = thumbs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? e.thumbnail ?? null;
  return {
    id: String(e.id ?? url),
    url,
    title: (e.title ?? "").trim(),
    site: SITE[extractor] ?? (extractor ? extractor[0].toUpperCase() + extractor.slice(1) : "web"),
    durationSec: typeof e.duration === "number" && Number.isFinite(e.duration) ? e.duration : null,
    thumbnailUrl: best,
    uploader: e.uploader ?? e.channel ?? null,
    viewCount: typeof e.view_count === "number" ? e.view_count : null,
    uploadDate: e.upload_date ?? null,
    width: e.width ?? null,
    height: e.height ?? null,
  };
}

/** Candidates from one `--dump-single-json` run: a search / playlist (entries) or a single video. */
export function parseSearchJson(stdout: string): WebVideoCandidate[] {
  const start = stdout.indexOf("{");
  if (start < 0) return [];
  let info: YtdlpEntry;
  try {
    info = JSON.parse(stdout.slice(start)) as YtdlpEntry;
  } catch {
    return [];
  }
  const entries = info.entries ?? [info];
  return entries.map(toCandidate).filter((c): c is WebVideoCandidate => c !== null);
}

/** One row per page URL; the first occurrence wins (search order = relevance). */
export function dedupeCandidates(list: WebVideoCandidate[]): WebVideoCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = c.url.replace(/[?&](feature|si|t)=[^&]*/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
