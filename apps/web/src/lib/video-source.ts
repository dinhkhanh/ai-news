/**
 * Projects made from a video page instead of a news article (`projects.source_kind = "video"`): which links count
 * as a video, the canonical form they are stored and deduplicated under, and how the downloaded file is cut into
 * the build's shots. Pure, no I/O (tested in video-source.test.ts); the network side is `media/source-video.ts`.
 */
import { WEB_VIDEO_PAGE } from "./media/visual-plan";

export type SourceKind = "article" | "video" | "text";

/** Longest part of a source video that is downloaded (from the start): the NAS API refuses longer sections. */
export const SOURCE_VIDEO_MAX_SEC = 120;

/**
 * Least content a script can be written from. An article needs some substance; a video's content is what the
 * user writes about it, and a video caption can be a single line, so one word is enough there.
 */
export const MIN_CONTENT_WORDS: Record<SourceKind, number> = { article: 40, text: 40, video: 1 };

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

export type SourceShot = { trimStartSec: number; clipDurationSec: number };

/**
 * The source video cut into the build's shots so it plays on continuously: every scene's time is split equally
 * between its shots (as `layoutShots` does), and each shot starts where the previous one ended. When the voice-over
 * outlasts the footage it starts over from the beginning; a shot longer than the whole video loops it.
 */
export function sourceVideoShots(scenes: Array<{ id: string; sec: number; shots: number }>, videoSec: number): Record<string, SourceShot[]> {
  const round = (n: number) => Math.round(n * 100) / 100;
  const out: Record<string, SourceShot[]> = {};
  let t = 0;
  for (const sc of scenes) {
    const n = Math.max(1, sc.shots);
    const d = Math.max(0, sc.sec) / n;
    out[sc.id] = [];
    for (let i = 0; i < n; i++) {
      // A little slack so rounding does not restart the video a few frames before its end.
      if (t + d > videoSec + 0.05 || t >= videoSec) t = 0;
      out[sc.id].push({ trimStartSec: round(t), clipDurationSec: round(Math.max(0.5, Math.min(d, videoSec - t))) });
      t += d;
    }
  }
  return out;
}
