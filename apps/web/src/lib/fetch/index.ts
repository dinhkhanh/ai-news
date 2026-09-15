import "server-only";
import { browserRenderContent, browserRenderScreenshot, browserRenderingAvailable, firecrawlAvailable, firecrawlScrape, httpGetHtml } from "./providers";
import { countWords, extractFromHtml, markdownToText, normaliseText, type Extracted } from "./readability";
import { isPrivateHost } from "@/lib/url";

export type FetchMethod = "browser_rendering" | "http" | "firecrawl" | "manual";
export type FetchAttempt = { method: FetchMethod; ok: boolean; ms: number; words?: number; error?: string };

export type FetchOutcome = {
  method: FetchMethod;
  extracted: Extracted;
  rawHtml: string | null;
  screenshot: Buffer | null;
  attempts: FetchAttempt[];
};

/** Below this the extraction is treated as failed and the next provider is tried. */
export const MIN_USABLE_WORDS = 120;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Extraction chain: Browser Rendering → plain HTTP → Firecrawl. Each provider's
 * HTML goes through the same Readability extractor; the first result with a
 * usable amount of text wins. `preferred` forces a single provider (re-fetch UI).
 */
export async function fetchArticle(url: string, opts: { preferred?: Exclude<FetchMethod, "manual">; screenshot?: boolean } = {}): Promise<FetchOutcome> {
  if (isPrivateHost(url)) throw new Error("Refusing to fetch a private or local address");
  const attempts: FetchAttempt[] = [];
  const order: Array<Exclude<FetchMethod, "manual">> = opts.preferred ? [opts.preferred] : ["browser_rendering", "http", "firecrawl"];
  let best: { method: FetchMethod; extracted: Extracted; rawHtml: string | null } | null = null;

  for (const method of order) {
    const t0 = Date.now();
    try {
      let html: string | null = null;
      let extracted: Extracted | null = null;
      if (method === "browser_rendering") {
        if (!(await browserRenderingAvailable())) throw new Error("not configured");
        html = (await browserRenderContent(url)).html;
      } else if (method === "http") {
        html = (await httpGetHtml(url)).html;
      } else {
        if (!(await firecrawlAvailable())) throw new Error("not enabled or no credits");
        const fc = await firecrawlScrape(url);
        html = fc.html;
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
      const ok = extracted.wordCount >= MIN_USABLE_WORDS;
      attempts.push({ method, ok, ms: Date.now() - t0, words: extracted.wordCount, ...(ok ? {} : { error: `only ${extracted.wordCount} words extracted` }) });
      if (!best || extracted.wordCount > best.extracted.wordCount) best = { method, extracted, rawHtml: html };
      if (ok) break;
    } catch (e) {
      attempts.push({ method, ok: false, ms: Date.now() - t0, error: errMsg(e) });
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
