import "server-only";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { recordUsageCost } from "@/lib/activity";
import { firecrawlSearch } from "@/lib/fetch/providers";
import { flagEnabled } from "@/lib/flags";
import { invokeMediaLambda, invokeWebVideo, type WebVideoCandidate } from "@/lib/media-lambda";
import { r2Key } from "@/lib/r2";
import { isPrivateHost } from "@/lib/url";
import type { ChosenAsset } from "./broll";
import { videoSegments } from "./visual-plan";

/**
 * Same-story footage from video sites (visual tier 2, same rank as other
 * outlets' images, see `visual-plan.ts`). Discovery is metadata-only:
 * YouTube search through yt-dlp on the media Lambda, plus video-page URLs
 * that Firecrawl's search turns up (TikTok, Facebook, Vimeo, …), also
 * resolved by yt-dlp. Haiku then places candidates by thumbnail + title
 * next to the article / related images, and only the picked videos are
 * downloaded – just the section that the scene's shots need. Behind the
 * `web_video_downloader` feature flag.
 */
export type { WebVideoCandidate };
export const WEB_VIDEO_PROVIDER = "yt-dlp";
const MEDIA_LAMBDA_USD_PER_SEC = 0.00006;
const MIN_SEC = 6;
const MAX_SEC = 20 * 60;
const VIDEO_PAGE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/|tiktok\.com\/@[^/]+\/video\/|facebook\.com\/(?:watch|reel|[^/]+\/videos)|fb\.watch\/|vimeo\.com\/\d|dailymotion\.com\/video)/i;

export const webVideoEnabled = () => flagEnabled("web_video_downloader");

/** Metadata of videos about the story: ytsearch + video pages from web search. Never downloads. */
export async function findWebVideos(input: { query: string; language: "vi" | "en"; limit?: number }): Promise<{ candidates: WebVideoCandidate[]; searched: number; errors: string[] }> {
  const errors: string[] = [];
  let urls: string[] = [];
  try {
    const hits = await firecrawlSearch(`${input.query} video`, { limit: 10, language: input.language });
    urls = hits.map((h) => h.url).filter((u) => VIDEO_PAGE.test(u) && !isPrivateHost(u)).slice(0, 6);
  } catch (e) {
    errors.push(`firecrawl: ${(e as Error).message.slice(0, 160)}`);
  }
  const res = await invokeMediaLambda({ action: "web-video-search", input: { query: input.query, urls, limit: input.limit ?? 8 } });
  if (!res.ok) {
    errors.push(`yt-dlp search: ${res.error ?? "unknown"}`);
    return { candidates: [], searched: 0, errors };
  }
  errors.push(...(res.warnings ?? []));
  const all = res.videos ?? [];
  const candidates = all.filter((c) => c.thumbnailUrl && c.durationSec != null && c.durationSec >= MIN_SEC && c.durationSec <= MAX_SEC && videoSegments(c.durationSec).capacity > 0);
  // Portrait clips fit the frame without cropping; otherwise keep search order (relevance).
  const portrait = (c: WebVideoCandidate) => (c.width && c.height && c.height > c.width ? 0 : 1);
  candidates.sort((a, b) => portrait(a) - portrait(b));
  return { candidates, searched: all.length, errors };
}

/** A found video that still knows which search turned it up and the scenes that search was run for ([] = the story). */
export type FoundWebVideo = WebVideoCandidate & { query: string; sceneIds: string[] };

/** Most candidates one search contributes to the placement model; the story search may bring more than a scene's. */
const PER_SCENE_QUERY = 4;
const PER_STORY_QUERY = 8;
const MAX_CANDIDATES = 16;

/**
 * All tier-2 video searches of a build at once (`tier2Queries` in
 * visual-plan.ts): one `findWebVideos` per query in parallel, merged
 * round-robin and deduped by URL, a video found twice credited to both scenes.
 */
export async function findWebVideosFor(queries: Array<{ query: string; sceneIds: string[] }>, opts: { language: "vi" | "en" }): Promise<{ candidates: FoundWebVideo[]; searched: number; errors: string[] }> {
  const results = await Promise.all(
    queries.map(async (q) => {
      const limit = q.sceneIds.length ? PER_SCENE_QUERY : PER_STORY_QUERY;
      const r = await findWebVideos({ query: q.query, language: opts.language, limit });
      return { ...r, candidates: r.candidates.slice(0, limit).map((c): FoundWebVideo => ({ ...c, query: q.query, sceneIds: q.sceneIds })) };
    }),
  );
  const byUrl = new Map<string, FoundWebVideo>();
  for (let i = 0; results.some((r) => r.candidates[i]); i++) {
    for (const r of results) {
      const c = r.candidates[i];
      if (!c) continue;
      const cur = byUrl.get(c.url);
      if (cur) cur.sceneIds = [...new Set([...cur.sceneIds, ...c.sceneIds])];
      else byUrl.set(c.url, { ...c });
    }
  }
  return { candidates: [...byUrl.values()].slice(0, MAX_CANDIDATES), searched: results.reduce((a, r) => a + r.searched, 0), errors: results.flatMap((r) => r.errors) };
}

/** Short hint for the placement model: what the thumbnail is, from where, how long. */
export const webVideoHint = (c: WebVideoCandidate, segments: number) => `web video, ${segments} shot${segments > 1 ? "s" : ""}: "${c.title.slice(0, 70)}" – ${c.uploader ?? c.site}, ${Math.round(c.durationSec ?? 0)} s`;

/** Suffix of a candidate's hint naming the scenes whose voice-over it was searched for ("what you hear is what you see"). */
export const foundForHint = (c: { query: string; sceneIds: string[] }) => (c.sceneIds.length ? `, found for ${c.sceneIds.join(" + ")} ("${c.query.slice(0, 50)}")` : "");

/**
 * Download the `[startSec, endSec)` section of one candidate through the media
 * Lambda and record it as a `web_video` asset (deduped org-wide by video + section).
 */
export async function storeWebVideo(
  c: WebVideoCandidate,
  opts: { buildId: string; startSec: number; endSec: number; index: number; /** `source`: the footage of a video project (`projects.source_video_asset_id`). */ role?: "source" },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<ChosenAsset> {
  const { organizationId, projectId } = ctx;
  const providerId = `${c.site.toLowerCase()}:${c.id}@${opts.startSec}-${opts.endSec}`;
  const credit = `Video: ${c.uploader ? `${c.uploader} / ` : ""}${c.site}`;
  const existing = await withOrgContext(ctx, (tx) =>
    tx.query.assets.findFirst({ where: and(eq(schema.assets.organizationId, organizationId), eq(schema.assets.provider, WEB_VIDEO_PROVIDER), eq(schema.assets.providerId, providerId)) }),
  );
  let durationSec = existing?.durationSec ? Number(existing.durationSec) : opts.endSec - opts.startSec;
  let key = existing?.r2Path ?? r2Key.media(organizationId, projectId, `webvideo/${opts.buildId}-${opts.index}.mp4`);
  let width = existing?.width ?? c.width ?? null;
  let height = existing?.height ?? c.height ?? null;
  let sizeBytes = existing?.sizeBytes ?? null;
  if (!existing) {
    const res = await invokeWebVideo({ action: "web-video", input: { url: c.url }, output: { key }, trim: { startSec: opts.startSec, endSec: opts.endSec } });
    // The self-hosted API costs nothing per call; only Lambda seconds are billed.
    const costUsd = ((res.billedMs ?? 0) / 1000) * MEDIA_LAMBDA_USD_PER_SEC;
    if (res.via === "lambda") await recordUsageCost({ provider: "media_lambda", resource: "web-video", units: (res.billedMs ?? 0) / 1000, unitType: "seconds", costUsd, userId: ctx.userId, organizationId, projectId, meta: { url: c.url.slice(0, 200) } });
    if (!res.ok) throw new Error(res.error ?? "download failed");
    key = res.outputKey ?? key;
    width = res.probe?.width ?? width;
    height = res.probe?.height ?? height;
    sizeBytes = res.probe?.sizeBytes ?? null;
    // A section asked past the end of the video (length unknown beforehand) is only as long as the file.
    if (res.probe?.durationSec && res.probe.durationSec < durationSec) durationSec = Math.round(res.probe.durationSec * 100) / 100;
  }
  const [row] = await withOrgContext(ctx, (tx) =>
    tx
      .insert(schema.assets)
      .values({
        organizationId, projectId, origin: "web_video", provider: WEB_VIDEO_PROVIDER, providerId, licence: "web video (editorial use, credited)", licenceUrl: null, sourceUrl: c.url, r2Path: key, hash: existing?.hash ?? null, mime: "video/mp4",
        width, height, durationSec: durationSec.toFixed(2), sizeBytes, searchTerm: null, sceneId: null, selected: false, thumbnailUrl: c.thumbnailUrl, attribution: credit,
        meta: { buildId: opts.buildId, ...(opts.role ? { role: opts.role } : {}), title: c.title, site: c.site, uploader: c.uploader, uploadDate: c.uploadDate, viewCount: c.viewCount, section: [opts.startSec, opts.endSec] },
      })
      .returning({ id: schema.assets.id }),
  );
  return { assetId: row.id, key, kind: "video", durationSec, credit, provider: WEB_VIDEO_PROVIDER, thumbnailUrl: c.thumbnailUrl };
}
