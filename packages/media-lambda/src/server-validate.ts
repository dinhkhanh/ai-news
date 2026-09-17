import type { MediaAction } from "./types.js";

/**
 * Request validation for the self-hosted web-video API (`server.ts`). The
 * service is reachable from the internet, so even with a valid token it only
 * does two things: yt-dlp metadata search and section downloads of public
 * video pages on known video sites, written to this app's web-video R2 paths.
 * No arbitrary URLs (which would let a caller reach the NAS's own network),
 * no arbitrary R2 keys.
 */
export const VIDEO_PAGE = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|shorts\/)|youtu\.be\/|tiktok\.com\/@[^/]+\/video\/|facebook\.com\/(?:watch|reel|[^/]+\/videos)|fb\.watch\/|vimeo\.com\/\d|dailymotion\.com\/video\/)/i;
const OUTPUT_KEY = /^(?:media\/[\w-]+\/[\w-]+\/webvideo\/|tmp\/smoke\/)[\w.-]+\.mp4$/;
const MAX_SECTION_SEC = 120;

export type Validated = { ok: true; event: Extract<MediaAction, { action: "web-video" | "web-video-search" }> } | { ok: false; status: number; error: string };

const bad = (error: string, status = 400): Validated => ({ ok: false, status, error });

export function validateInvoke(body: unknown): Validated {
  if (!body || typeof body !== "object") return bad("JSON object expected");
  const b = body as { action?: unknown; input?: { url?: unknown; query?: unknown; urls?: unknown; limit?: unknown }; output?: { key?: unknown }; trim?: { startSec?: unknown; endSec?: unknown } };
  if (b.action === "web-video-search") {
    const query = typeof b.input?.query === "string" ? b.input.query.trim().slice(0, 200) : undefined;
    const urls = Array.isArray(b.input?.urls) ? b.input.urls.filter((u): u is string => typeof u === "string" && VIDEO_PAGE.test(u)).slice(0, 10) : [];
    if (!query && urls.length === 0) return bad("query or urls required");
    // A leading dash would be read by yt-dlp as an option.
    if (query?.startsWith("-")) return bad("invalid query");
    const limit = Number.isFinite(Number(b.input?.limit)) ? Math.min(Math.max(Math.round(Number(b.input?.limit)), 1), 20) : 8;
    return { ok: true, event: { action: "web-video-search", input: { query, urls, limit } } };
  }
  if (b.action === "web-video") {
    const url = b.input?.url;
    if (typeof url !== "string" || url.length > 500 || !VIDEO_PAGE.test(url)) return bad("url must be a public video page on a supported site");
    const key = b.output?.key;
    if (typeof key !== "string" || key.length > 300 || key.includes("..") || !OUTPUT_KEY.test(key)) return bad("output.key must be a web-video path of this app");
    const startSec = Number(b.trim?.startSec);
    const endSec = Number(b.trim?.endSec);
    // Whole-video downloads are not offered: a NAS should never pull an hour of 1080p because of one request.
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec || endSec - startSec > MAX_SECTION_SEC) return bad(`trim is required, at most ${MAX_SECTION_SEC} s`);
    return { ok: true, event: { action: "web-video", input: { url }, output: { key }, trim: { startSec, endSec } } };
  }
  return bad("only web-video and web-video-search are served here", 403);
}
