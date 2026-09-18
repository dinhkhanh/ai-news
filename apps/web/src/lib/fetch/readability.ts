/**
 * HTML → article text + metadata + flags. Pure (no network) so it is unit-tested
 * on fixtures. Mozilla Readability on a linkedom DOM keeps the Vercel bundle small.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export type ArticleImage = { url: string; alt?: string; width?: number; height?: number };
export type ArticleFlags = { paywall?: boolean; liveBlog?: boolean; videoOnly?: boolean; short?: boolean };

export type Extracted = {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  publishedAt: Date | null;
  lang: string | null;
  canonicalUrl: string | null;
  text: string;
  excerpt: string | null;
  contentHtml: string | null;
  images: ArticleImage[];
  wordCount: number;
  flags: ArticleFlags;
};

type Ld = Record<string, unknown>;

/** Word count that also works for Vietnamese (syllables separated by spaces). */
export function countWords(text: string) {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Normalise extracted text: collapse whitespace, keep paragraph breaks, strip control chars. */
export function normaliseText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function flattenLd(node: unknown, out: Ld[] = []): Ld[] {
  if (Array.isArray(node)) node.forEach((n) => flattenLd(n, out));
  else if (node && typeof node === "object") {
    const o = node as Ld;
    if (o["@type"]) out.push(o);
    if (Array.isArray(o["@graph"])) flattenLd(o["@graph"], out);
  }
  return out;
}

function typesOf(ld: Ld): string[] {
  const t = ld["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

/**
 * Many CMSes HTML-encode the strings they put in JSON-LD ("Ph&#243; Thủ tướng"). `JSON.parse` leaves entities
 * alone, unlike the DOM for attributes and text, so such a headline would be stored and shown literally.
 */
export function decodeEntities(s: string) {
  if (!/&(#\d+|#x[\da-f]+|[a-z][\da-z]*);/i.test(s)) return s;
  const { document } = parseHTML("<!doctype html><html><body><p></p></body></html>");
  const p = document.querySelector("p");
  if (!p) return s;
  // Only entities are to be read as HTML: a literal "<" must not start a tag.
  p.innerHTML = s.replace(/</g, "&lt;");
  return p.textContent ?? s;
}

function ldString(v: unknown): string | null {
  if (typeof v === "string") return decodeEntities(v).trim() || null;
  if (Array.isArray(v)) return ldString(v[0]);
  if (v && typeof v === "object") {
    const o = v as Ld;
    return ldString(o.name ?? o.url ?? o["@id"]);
  }
  return null;
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function absolute(src: string | null | undefined, base: string): string | null {
  if (!src) return null;
  const s = src.trim();
  if (!s || s.startsWith("data:") || s.startsWith("blob:")) return null;
  try {
    const u = new URL(s, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function extractFromHtml(html: string, url: string): Extracted {
  const { document } = parseHTML(html);
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.getAttribute("content")?.trim() || null;

  // ---- structured data ----
  const ld: Ld[] = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      flattenLd(JSON.parse(s.textContent ?? ""), ld);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  const articleLd = ld.find((n) => typesOf(n).some((t) => /Article|BlogPosting|NewsArticle|LiveBlogPosting|ReportageNewsArticle/.test(t))) ?? null;
  const ldTypes = ld.flatMap(typesOf);

  // ---- readability ----
  const canonicalUrl =
    absolute(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), url) ?? absolute(meta('meta[property="og:url"]'), url);
  let article: ReturnType<Readability["parse"]> = null;
  try {
    // Readability mutates the DOM; clone so the metadata queries above/below stay intact.
    const { document: clone } = parseHTML(html);
    article = new Readability(clone as unknown as Document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }

  let text = normaliseText(article?.textContent ?? "");
  if (countWords(text) < 40) {
    // Fallback: paragraphs anywhere in the body.
    const ps = Array.from(document.querySelectorAll("article p, main p, p"))
      .map((p) => p.textContent?.trim() ?? "")
      .filter((t) => countWords(t) >= 4);
    const alt = normaliseText(ps.join("\n\n"));
    if (countWords(alt) > countWords(text)) text = alt;
  }

  const title =
    ldString(articleLd?.headline) ??
    meta('meta[property="og:title"]') ??
    article?.title?.trim() ??
    document.querySelector("title")?.textContent?.trim() ??
    null;
  const byline =
    ldString(articleLd?.author) ?? meta('meta[name="author"]') ?? meta('meta[property="article:author"]') ?? article?.byline?.trim() ?? null;
  const siteName =
    meta('meta[property="og:site_name"]') ?? ldString((articleLd?.publisher as Ld | undefined)?.name) ?? article?.siteName?.trim() ?? null;
  const publishedAt = parseDate(
    ldString(articleLd?.datePublished) ??
      meta('meta[property="article:published_time"]') ??
      meta('meta[name="pubdate"]') ??
      meta('meta[name="date"]') ??
      meta('meta[itemprop="datePublished"]'),
  );
  const lang = (document.documentElement?.getAttribute("lang") || meta('meta[property="og:locale"]') || article?.lang || "").split(/[-_]/)[0].toLowerCase() || null;

  // ---- images ----
  const images: ArticleImage[] = [];
  const seen = new Set<string>();
  const push = (src: string | null, alt?: string | null, w?: number, h?: number) => {
    if (!src || seen.has(src)) return;
    if (/\.(svg|gif)(\?|$)/i.test(src)) return;
    if ((w && w < 300) || (h && h < 300)) return;
    seen.add(src);
    images.push({ url: src, alt: alt?.trim() || undefined, width: w || undefined, height: h || undefined });
  };
  push(
    absolute(meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]'), url),
    meta('meta[property="og:image:alt"]'),
    Number(meta('meta[property="og:image:width"]')) || undefined,
    Number(meta('meta[property="og:image:height"]')) || undefined,
  );
  for (const img of (articleLd?.image ? (Array.isArray(articleLd.image) ? articleLd.image : [articleLd.image]) : []) as unknown[]) {
    const o = (img && typeof img === "object" ? (img as Ld) : { url: img }) as Ld;
    push(absolute(ldString(o.url ?? o.contentUrl ?? o), url), null, Number(o.width) || undefined, Number(o.height) || undefined);
  }
  if (article?.content) {
    const { document: cdoc } = parseHTML(`<body>${article.content}</body>`);
    for (const img of cdoc.querySelectorAll("img")) {
      const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src");
      push(absolute(src, url), img.getAttribute("alt"), Number(img.getAttribute("width")) || undefined, Number(img.getAttribute("height")) || undefined);
      if (images.length >= 12) break;
    }
  }

  // ---- flags ----
  const wordCount = countWords(text);
  const notFree = ld.some((n) => n.isAccessibleForFree === false || n.isAccessibleForFree === "False") ||
    ld.some((n) => flattenLd(n.hasPart).some((p) => p.isAccessibleForFree === false));
  const paywallMarkup = Boolean(document.querySelector('[class*="paywall" i], [id*="paywall" i], [class*="subscribe-wall" i], [class*="piano-" i], [data-paywall]'));
  const paywall = notFree || (paywallMarkup && wordCount < 250);
  const liveBlog = ldTypes.includes("LiveBlogPosting") || /(\/live[-_/]|\/truc-tiep|tuong-thuat-truc-tiep|\/liveblog)/i.test(url);
  const ogType = meta('meta[property="og:type"]') ?? "";
  const videoOnly = wordCount < 120 && (ogType.startsWith("video") || ldTypes.includes("VideoObject") || Boolean(document.querySelector("video, iframe[src*='youtube'], iframe[src*='player']")));
  const short = wordCount < 120;

  return {
    title,
    byline,
    siteName,
    publishedAt,
    lang,
    canonicalUrl,
    text,
    excerpt: article?.excerpt?.trim() || meta('meta[property="og:description"]') || meta('meta[name="description"]') || null,
    contentHtml: article?.content ?? null,
    images,
    wordCount,
    flags: { ...(paywall ? { paywall } : {}), ...(liveBlog ? { liveBlog } : {}), ...(videoOnly ? { videoOnly } : {}), ...(short ? { short } : {}) },
  };
}

/** Markdown (Firecrawl) → plain text good enough for scripting. */
export function markdownToText(md: string) {
  return normaliseText(
    md
      .replace(/```[\s\S]*?```/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^[-*_]{3,}\s*$/gm, "")
      .replace(/^[ \t]*[-*+][ \t]+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
      .replace(/<[^>]+>/g, ""),
  );
}
