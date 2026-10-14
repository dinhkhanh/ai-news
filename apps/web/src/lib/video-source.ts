/**
 * Projects made from a video page instead of a news article (`projects.source_kind = "video"`): which links count
 * as a video, the canonical form they are stored and deduplicated under, and how the downloaded file is cut into
 * the build's shots. Pure, no I/O (tested in video-source.test.ts); the network side is `media/source-video.ts`.
 */
import { formatTimecode, parseTimecode, WEB_VIDEO_PAGE } from "./media/visual-plan";

/**
 * `projects.source_kind`; `topic` = a brief researched on the web (`llm/research.ts`, helpers in `llm/research-sources.ts`),
 * `comic` = a motion comic (`comic/motion.ts`): its script is built from the comic's lettering, never written by a model.
 */
export type SourceKind = "article" | "video" | "text" | "topic" | "comic";

/**
 * Longest part of a source video that is downloaded (from the start): a safety cap well above social videos
 * (TikTok uploads stop at 10 min), so a pasted hour-long video cannot tie up the video box or fill R2.
 * The video box (`MAX_SECTION_SEC` in packages/media-lambda/src/server-validate.ts) refuses longer sections.
 */
export const SOURCE_VIDEO_MAX_SEC = 600;

/**
 * Least content a script can be written from. An article needs some substance; a video's content is what the
 * user writes about it, and a video caption can be a single line, so one word is enough there.
 */
export const MIN_CONTENT_WORDS: Record<SourceKind, number> = { article: 40, text: 40, topic: 40, video: 1, comic: 1 };

/** Share links that redirect to a video page: TikTok app links, Facebook share links. */
const SHORT_VIDEO_LINK = /^https?:\/\/(?:(?:vt|vm)\.tiktok\.com\/\w|(?:www\.|m\.)?tiktok\.com\/t\/\w|(?:www\.|m\.|web\.)?facebook\.com\/share\/(?:r|v)\/\w)/i;

/**
 * A pasted link as the video page it names, in one canonical form (https, `www.` host, no tracking query) that the
 * downloader accepts and that duplicate checks compare: YouTube → `watch?v=` or `shorts/<id>`, TikTok →
 * `/@user/video/<id>`, Facebook → `reel/<id>` / `watch?v=<id>` / `<page>/videos/<id>`. Null when it is not a video page.
 */
export function videoPageUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.protocol = "https:";
  u.hash = "";
  u.username = "";
  u.password = "";
  u.port = "";
  const host = u.hostname.toLowerCase().replace(/^(?:www|m|web|mobile|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    if (!id) return null;
    return check(`https://www.youtube.com/watch?v=${id}`);
  }
  if (host === "youtube.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      return id ? check(`https://www.youtube.com/watch?v=${id}`) : null;
    }
    return check(`https://www.youtube.com${trimSlash(u.pathname)}`);
  }
  if (host === "facebook.com") {
    const v = u.pathname.startsWith("/watch") ? u.searchParams.get("v") : null;
    return check(v ? `https://www.facebook.com/watch?v=${v}` : `https://www.facebook.com${trimSlash(u.pathname)}`);
  }
  if (host === "fb.watch") return check(`https://fb.watch${trimSlash(u.pathname)}/`);
  if (host === "tiktok.com" || host === "vimeo.com" || host === "dailymotion.com") return check(`https://www.${host}${trimSlash(u.pathname)}`);
  return null;
}

const trimSlash = (path: string) => path.replace(/\/{2,}/g, "/").replace(/\/$/, "");
const check = (url: string) => (WEB_VIDEO_PAGE.test(url) ? url : null);

/** `page`: a video page as is; `short`: a share link that has to be followed to the page first; null: not a video. */
export function videoLinkKind(input: string): "page" | "short" | null {
  if (videoPageUrl(input)) return "page";
  const t = input.trim();
  return SHORT_VIDEO_LINK.test(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`) ? "short" : null;
}

/** yt-dlp's `upload_date` (YYYYMMDD) as a date, null when absent or unreadable. */
export function uploadDate(value: string | null | undefined): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The part of a video project's source the user asked for; null ends = the start / the end of the video. */
export type SourceSegment = { startSec: number | null; endSec: number | null };

/**
 * The "từ … đến …" fields of the new-project form and of "Tải lại video", read before anything is downloaded (the
 * video's length is not known yet): blank fields = the whole video, timecodes as `parseTimecode` reads them.
 */
export function parseSourceSegment(startText: string, endText: string): { ok: true; segment: SourceSegment } | { ok: false; error: string } {
  const start = startText.trim() ? parseTimecode(startText) : null;
  const end = endText.trim() ? parseTimecode(endText) : null;
  if (startText.trim() && start === null) return { ok: false, error: `Mốc bắt đầu “${startText.trim()}” không đọc được (vd. 0:45 hoặc 1:02:03)` };
  if (endText.trim() && end === null) return { ok: false, error: `Mốc kết thúc “${endText.trim()}” không đọc được (vd. 2:30)` };
  if (start !== null && end !== null && end - start < 1) return { ok: false, error: "Mốc kết thúc phải sau mốc bắt đầu ít nhất 1 giây" };
  if (end !== null && end - (start ?? 0) > SOURCE_VIDEO_MAX_SEC) return { ok: false, error: `Đoạn dùng tối đa ${formatTimecode(SOURCE_VIDEO_MAX_SEC)} (${SOURCE_VIDEO_MAX_SEC / 60} phút)` };
  return { ok: true, segment: { startSec: start ? Math.round(start * 10) / 10 : null, endSec: end !== null ? Math.round(end * 10) / 10 : null } };
}

/**
 * The section to download once the video's length is known: the segment cut to the video, at most
 * `SOURCE_VIDEO_MAX_SEC` long; `truncated` = the video (or the open-ended segment) went on past that cap.
 */
export function sourceSection(segment: SourceSegment, durationSec: number | null): { ok: true; startSec: number; endSec: number; truncated: boolean } | { ok: false; error: string } {
  const length = durationSec && durationSec > 0 ? durationSec : null;
  const start = segment.startSec ?? 0;
  if (length !== null && start >= length - 0.5) return { ok: false, error: `Video chỉ dài ${formatTimecode(length)}: mốc bắt đầu ${formatTimecode(start)} nằm ngoài video` };
  const wanted = Math.min(segment.endSec ?? Number.POSITIVE_INFINITY, length ?? Number.POSITIVE_INFINITY);
  const end = Math.min(wanted, start + SOURCE_VIDEO_MAX_SEC);
  return { ok: true, startSec: start, endSec: Math.round(end * 100) / 100, truncated: wanted > end };
}
