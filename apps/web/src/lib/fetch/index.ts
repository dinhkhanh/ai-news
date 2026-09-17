import "server-only";
import { browserRenderContent, browserRenderScreenshot, browserRenderingAvailable, firecrawlAvailable, firecrawlScrape, httpGetHtml } from "./providers";
import { BlockedError, detectBlock } from "./blocked";
import { countWords, extractFromHtml, markdownToText, normaliseText, type Extracted } from "./readability";
import { isPrivateHost } from "@/lib/url";

export type FetchMethod = "browser_rendering" | "http" | "firecrawl" | "manual";
export type FetchProvider = Exclude<FetchMethod, "manual">;
/** `blocked`: the site refused this provider (anti-bot wall, captcha, 403/429, login redirect, truncating paywall). */
export type FetchAttempt = { method: FetchMethod; ok: boolean; ms: number; words?: number; blocked?: boolean; error?: string };

export type FetchOutcome = {
  method: FetchMethod;
  extracted: Extracted;
  rawHtml: string | null;
  screenshot: Buffer | null;
  attempts: FetchAttempt[];
};

/** Below this the extraction is treated as failed and the next provider is tried. */
export const MIN_USABLE_WORDS = 120;
/** A paywalled page with less text than this is taken as the teaser, so the other providers get a try. */
const PAYWALL_TEASER_WORDS = 300;

export const FETCH_METHOD_LABEL: Record<FetchMethod, string> = { browser_rendering: "Browser Rendering", http: "HTTP", firecrawl: "Firecrawl", manual: "dán thủ công" };

export const FETCH_CHAIN: readonly FetchProvider[] = ["browser_rendering", "http", "firecrawl"];

/** The chain with `preferred` moved to the front; nothing is ever dropped, so a blocked provider always has a successor. */
export const fetchOrder = (preferred?: FetchProvider): FetchProvider[] => (preferred ? [preferred, ...FETCH_CHAIN.filter((m) => m !== preferred)] : [...FETCH_CHAIN]);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Extraction chain: Browser Rendering → plain HTTP → Firecrawl. Each provider's
 * HTML goes through the same Readability extractor; the first usable result wins.
 * A provider that errors, is blocked (`detectBlock`), or returns too little text
 * hands over to the next one. `preferred` (re-fetch UI) only picks which provider
 * goes first; the rest of the chain still follows.
 */
export async function fetchArticle(
  url: string,
  opts: { preferred?: FetchProvider; screenshot?: boolean; onAttempt?: (next: FetchProvider, previous: FetchAttempt | null) => void | Promise<void> } = {},
): Promise<FetchOutcome> {
  if (isPrivateHost(url)) throw new Error("Refusing to fetch a private or local address");
  const attempts: FetchAttempt[] = [];
  let best: { method: FetchMethod; extracted: Extracted; rawHtml: string | null } | null = null;

  for (const method of fetchOrder(opts.preferred)) {
    await opts.onAttempt?.(method, attempts.at(-1) ?? null);
    const t0 = Date.now();
    try {
      let html: string | null = null;
      let extracted: Extracted | null = null;
      let status: number | null = null;
      let finalUrl: string | null = null;
      if (method === "browser_rendering") {
        if (!(await browserRenderingAvailable())) throw new Error("not configured");
        html = (await browserRenderContent(url)).html;
      } else if (method === "http") {
        const got = await httpGetHtml(url);
        html = got.html;
        finalUrl = got.finalUrl;
      } else {
        if (!(await firecrawlAvailable())) throw new Error("not enabled or no credits");
        const fc = await firecrawlScrape(url);
        html = fc.html;
        status = fc.metadata.statusCode ?? null;
        finalUrl = fc.metadata.url ?? null;
        if (html) extracted = extractFromHtml(html, url);
        if (!extracted || extracted.wordCount < MIN_USABLE_WORDS) {
          const text = fc.markdown ? markdownToText(fc.markdown) : "";
          if (countWords(text) > (extracted?.wordCount ?? 0)) {
            extracted = {
              title: fc.metadata.title ?? extracted?.title ?? null,
              byline: fc.metadata.author ?? extracted?.byline ?? null,
              siteName: extracted?.siteName ?? null,
              publishedAt: fc.metadata.publishedTime ? new Date(fc.metadata.publishedTime) : (extracted?.publishedAt ?? null),
              lang: fc.metadata.language?.split(/[-_]/)[0]?.toLowerCase() ?? extracted?.lang ?? null,
              canonicalUrl: fc.metadata.sourceURL ?? extracted?.canonicalUrl ?? null,
              text,
              excerpt: fc.metadata.description ?? extracted?.excerpt ?? null,
              contentHtml: null,
              images: fc.metadata.ogImage ? [{ url: fc.metadata.ogImage }] : (extracted?.images ?? []),
              wordCount: countWords(text),
              flags: { ...(extracted?.flags ?? {}), ...(countWords(text) < MIN_USABLE_WORDS ? { short: true } : {}) },
            };
          }
        }
      }
      extracted ??= extractFromHtml(html ?? "", url);
      const words = extracted.wordCount;

      // A wall is not the article: never keep it, whatever its length.
      const wall = detectBlock({ html, text: extracted.text, wordCount: words, status, requestedUrl: url, finalUrl });
      if (wall) throw new BlockedError(wall);

      // A paywall teaser is real text, so it stays a candidate, but another provider may get the whole article.
      const teaser = Boolean(extracted.flags.paywall) && words < PAYWALL_TEASER_WORDS;
      const ok = words >= MIN_USABLE_WORDS && !teaser;
      attempts.push({ method, ok, ms: Date.now() - t0, words, ...(teaser ? { blocked: true } : {}), ...(ok ? {} : { error: teaser ? `blocked: paywall, only ${words} words` : `only ${words} words extracted` }) });
      if (!best || words > best.extracted.wordCount) best = { method, extracted, rawHtml: html };
      if (ok) break;
    } catch (e) {
      attempts.push({ method, ok: false, ms: Date.now() - t0, ...(e instanceof BlockedError ? { blocked: true } : {}), error: errMsg(e) });
    }
  }

  if (!best || best.extracted.wordCount === 0) {
    throw new Error(`Could not extract the article: ${attempts.map((a) => `${a.method}: ${a.error ?? "no text"}`).join(" · ")}`);
  }

  let screenshot: Buffer | null = null;
  if (opts.screenshot !== false && (await browserRenderingAvailable())) {
    try {
      screenshot = (await browserRenderScreenshot(url)).jpeg;
    } catch (e) {
      console.warn("[fetch] screenshot skipped:", errMsg(e)); // best effort; the review view works without it
      screenshot = null;
    }
  }
  return { ...best, screenshot, attempts };
}

/** Manual paste path: same shape as a fetched article so downstream code is identical. */
export function manualArticle(input: { title: string; text: string; url: string; siteName?: string | null }): Extracted {
  const text = normaliseText(input.text);
  const wordCount = countWords(text);
  return {
    title: input.title.trim() || null,
    byline: null,
    siteName: input.siteName ?? null,
    publishedAt: null,
    lang: null,
    canonicalUrl: input.url,
    text,
    excerpt: null,
    contentHtml: null,
    images: [],
    wordCount,
    flags: wordCount < MIN_USABLE_WORDS ? { short: true } : {},
  };
}
