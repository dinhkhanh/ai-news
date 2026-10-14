import "server-only";
import { NonRetriableError } from "inngest";
import { nanoid } from "nanoid";
import { invokeWebVideo, type WebVideoCandidate } from "@/lib/media-lambda";
import { countWords, normaliseText, type Extracted } from "@/lib/fetch/readability";
import { sourceSection, uploadDate, videoLinkKind, videoPageUrl, type SourceSegment } from "@/lib/video-source";
import type { ChosenAsset } from "./broll";
import { storeWebVideoJob, webVideoEnabled } from "./webvideo";

/**
 * Video projects (`projects.source_kind = "video"`): the pasted link is a video page (YouTube, TikTok, Facebook…),
 * its file is the footage of the whole video and its title / caption seed the content the user then writes.
 * Metadata and the download both go through `invokeWebVideo` (the NAS on an ISP line, else the Lambda).
 */

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/**
 * A pasted link as its canonical video page: a page as is, a share link (vt.tiktok.com, facebook.com/share/r/…)
 * followed through its redirects, hop by hop, without reading any body. Null when it is not a video link at all;
 * throws when it looks like one but does not lead to a video page.
 */
export async function resolveVideoLink(input: string): Promise<string | null> {
  const kind = videoLinkKind(input);
  if (kind === "page") return videoPageUrl(input);
  if (kind !== "short") return null;
  let url = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "User-Agent": BROWSER_UA, "Accept-Language": "vi,en;q=0.8" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const location = res?.headers.get("location");
    await res?.body?.cancel().catch(() => {});
    if (!location) break;
    const next = new URL(location, url);
    // Facebook sends visitors without a session to its login page with the destination in `next`.
    const target = /\/login/.test(next.pathname) && next.searchParams.get("next") ? next.searchParams.get("next")! : next.toString();
    const page = videoPageUrl(target);
    if (page) return page;
    url = target;
  }
  throw new Error("Không mở được link chia sẻ này tới trang video. Hãy dán link đầy đủ của video (mở video rồi sao chép địa chỉ trên trình duyệt).");
}

/** yt-dlp metadata of one video page (title, caption, length, uploader); never downloads. */
export async function lookupVideo(pageUrl: string): Promise<WebVideoCandidate> {
  const res = await invokeWebVideo({ action: "web-video-search", input: { urls: [pageUrl], limit: 1 } });
  const c = res.ok ? res.videos?.[0] : undefined;
  if (!c) throw new Error(`Không đọc được trang video${res.error ? `: ${res.error}` : res.warnings?.[0] ? `: ${res.warnings[0]}` : ""}`);
  return { ...c, url: videoPageUrl(c.url) ?? pageUrl };
}

/**
 * The segment the user chose (`projects.source_start_sec` / `source_end_sec`; none = the whole video), at most
 * `SOURCE_VIDEO_MAX_SEC` (10 min), as a `web_video` asset tagged `role: "source"`, starting at 0. It can keep
 * the video box busy for minutes (decoding, one H.264 encode), longer than one function may run: after `wait.waitMs`
 * this returns `{ pending: jobId }`, and the caller's next durable step passes that `jobId` back to keep waiting.
 */
export async function downloadSourceVideo(
  c: WebVideoCandidate,
  ctx: { userId: string; organizationId: string; projectId: string },
  wait: { jobId?: string | null; waitMs?: number } = {},
  segment: SourceSegment = { startSec: null, endSec: null },
): Promise<(ChosenAsset & { truncated: boolean; startSec: number; endSec: number }) | { pending: string }> {
  if (!(await webVideoEnabled())) throw new Error("Tải video web đang tắt (cờ web_video_downloader tại /admin/integrations)");
  const section = sourceSection(segment, c.durationSec);
  // A start past the end of the video will not get better by retrying: the user picks another segment.
  if (!section.ok) throw new NonRetriableError(section.error);
  const r = await storeWebVideoJob(c, { buildId: `source-${nanoid(6)}`, startSec: section.startSec, endSec: section.endSec, index: 0, role: "source" }, ctx, wait);
  return "pending" in r ? r : { ...r.asset, truncated: section.truncated, startSec: section.startSec, endSec: section.endSec };
}

/** The video's own words as the project's starting content: its caption (or title), for the user to rewrite. */
export function videoArticle(c: WebVideoCandidate): Extracted {
  const text = normaliseText(c.description?.trim() || c.title || "");
  return {
    title: c.title.trim() || null,
    byline: c.uploader,
    siteName: c.site,
    publishedAt: uploadDate(c.uploadDate),
    lang: null,
    canonicalUrl: c.url,
    text,
    excerpt: null,
    contentHtml: null,
    images: c.thumbnailUrl ? [{ url: c.thumbnailUrl, ...(c.width ? { width: c.width } : {}), ...(c.height ? { height: c.height } : {}) }] : [],
    wordCount: countWords(text),
    flags: {},
  };
}
