/**
 * "Was this fetch blocked?" Pure (no network) so it is unit-tested on fixtures.
 * A blocked result is never kept as the article; the chain moves to the next provider.
 */
import { countWords } from "./readability";

/** Thrown by a provider that can already tell it was refused (HTTP status). */
export class BlockedError extends Error {
  constructor(reason: string) {
    super(`blocked: ${reason}`);
    this.name = "BlockedError";
  }
}

/** Statuses anti-bot layers answer with: auth walls, WAF refusals, rate limits, geo/legal blocks, challenge interstitials. */
const BLOCK_STATUS = new Set([401, 402, 403, 406, 407, 429, 451, 503]);
export const isBlockStatus = (status: number | null | undefined) => status != null && BLOCK_STATUS.has(status);

/** A challenge page this long is rare, and a long article may legitimately talk about captchas: nothing counts as a block above it. */
const BLOCK_PAGE_MAX_WORDS = 300;

/** Interstitial titles, anchored at the start. */
const TITLE_PATTERNS: Array<[RegExp, string]> = [
  [/^(just a moment|one moment,? please|checking your browser|please wait\W*$)/i, "challenge page"],
  [/^attention required/i, "Cloudflare block page"],
  [/^(access|permission) (to this page has been |has been |is )?denied/i, "access denied page"],
  [/^(error\s*)?(401|403|429|451|503)\b/i, "error page"],
  [/^(403\s*)?forbidden/i, "403 page"],
  [/^(are you a (robot|human)|robot or human|human verification|bot verification|security check\W*$|captcha\W*$)/i, "captcha page"],
  [/^(please )?verify (that )?you('re| are) (a )?human/i, "captcha page"],
  [/^pardon our interruption/i, "bot wall"],
  [/^(request (blocked|rejected|unsuccessful)|blocked\W*$|sorry, you have been blocked|you have been blocked)/i, "block page"],
  [/^(ddos-guard|sucuri website firewall)/i, "firewall page"],
  [/^(too many requests|rate limit(ed)?)/i, "rate limited"],
  [/^(unavailable for legal reasons|(this )?(content|site|page) is not available in your (country|region))/i, "geo block"],
  [/^(truy cập bị (từ chối|chặn)|xác (minh|nhận) (bạn )?không phải)/i, "block page"],
];

/** Markup that only a vendor's challenge/block page carries (not the scripts they inject on normal pages). */
const HTML_MARKERS: Array<[RegExp, string]> = [
  [/_cf_chl_opt|cf-chl-|cf-browser-verification|challenge-error-text|cf-error-details/i, "Cloudflare challenge"],
  [/captcha-delivery\.com/i, "DataDome captcha"],
  [/px-captcha/i, "PerimeterX captcha"],
  [/Incapsula incident ID/i, "Imperva block"],
  [/captcha\.awswaf\.com|window\.gokuProps/i, "AWS WAF challenge"],
  [/sucuri_cloudproxy/i, "Sucuri firewall"],
  [/errors\.edgesuite\.net/i, "Akamai block"],
];

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/enable javascript and cookies to continue|checking (if the site connection is secure|your browser before)/i, "challenge page"],
  [/verify(ing)? (that )?you are (a )?(human|not a (ro)?bot)|are you a robot|i('| a)m not a robot|press (and|&) hold|complete the (captcha|security check)/i, "captcha page"],
  [/unusual (traffic|activity) from your|automated (access|requests|queries|traffic)|bot-like behaviou?r/i, "bot wall"],
  [/access (to this (page|site|resource|website) )?(is|has been) (denied|blocked|restricted|forbidden)|you (have been|are) blocked|you don'?t have permission to access/i, "access denied page"],
  [/(is )?not available in your (country|region|location)/i, "geo block"],
  [/too many requests|rate limit exceeded/i, "rate limited"],
  [/xác (minh|nhận) (rằng )?(bạn )?không phải (là )?(robot|người máy)|truy cập (của bạn )?(đã )?bị (từ chối|chặn)|bạn không có quyền truy cập/i, "block page"],
];

/** A redirect that lands on a login/consent/captcha URL the original did not point at. */
const WALL_URL = /(^|[/._-])(login|signin|sign-in|sso|captcha|challenge|consent|blocked|denied|verify)([/._?-]|$)/i;

function visibleText(html: string) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/\s+/g, " ");
}

export type BlockInput = {
  html: string | null;
  /** Extracted article text and its word count. */
  text: string;
  wordCount: number;
  /** Status of the target page when the provider reports it. */
  status?: number | null;
  requestedUrl?: string;
  finalUrl?: string | null;
};

/** Returns a short reason when the response is an anti-bot / access wall instead of the article, else null. */
export function detectBlock(input: BlockInput): string | null {
  const { html, wordCount } = input;

  if (wordCount >= BLOCK_PAGE_MAX_WORDS) return null;

  if (isBlockStatus(input.status)) return `HTTP ${input.status}`;

  const title = html ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
  if (title) for (const [re, reason] of TITLE_PATTERNS) if (re.test(title)) return `${reason} ("${title.slice(0, 60)}")`;

  if (input.requestedUrl && input.finalUrl) {
    try {
      const from = new URL(input.requestedUrl);
      const to = new URL(input.finalUrl);
      const was = from.hostname + from.pathname;
      const now = to.hostname + to.pathname;
      if (was !== now && WALL_URL.test(now) && !WALL_URL.test(was)) return `redirected to ${to.hostname}${to.pathname.slice(0, 40)}`;
    } catch {
      /* unparsable URL: no redirect signal */
    }
  }

  if (html) for (const [re, reason] of HTML_MARKERS) if (re.test(html)) return reason;

  // Readability may drop the wall's message, so look at the whole visible page as well (only when it is small).
  const page = html ? visibleText(html) : "";
  const haystack = `${input.text}\n${countWords(page) < BLOCK_PAGE_MAX_WORDS * 2 ? page : ""}`;
  for (const [re, reason] of TEXT_PATTERNS) if (re.test(haystack)) return reason;

  return null;
}
