import "server-only";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { bingNewsSearch, firecrawlSearch, httpGetHtml, type SearchHit } from "@/lib/fetch/providers";
import { extractFromHtml, type ArticleImage } from "@/lib/fetch/readability";
import { deleteObject, r2Key } from "@/lib/r2";
import { isPrivateHost } from "@/lib/url";
import type { ChosenAsset } from "./broll";
import { downloadToR2 } from "./stock";

/**
 * More A-roll for a story: when the source article does not carry enough
 * usable pictures for a picture change every ≤ 5 s, search other outlets
 * covering the same topic, extract their article images and store them as
 * assets (origin "article", provider "related", source_url = the outlet page).
 * Search: Firecrawl (if enabled) → Bing News RSS (free). Pages are fetched
 * with plain HTTP only, so this never spends Browser Rendering or scrape credits.
 */
export type RelatedImage = ArticleImage & { pageUrl: string; pageTitle: string | null; siteName: string | null };

const MIN_WIDTH = 600;
const MAX_PAGES = 6;
const MAX_PER_PAGE = 4;

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const usableImage = (im: ArticleImage) => !/\.(gif|svg)(?:$|\?)/i.test(im.url) && (im.width ?? 1000) >= MIN_WIDTH && !/logo|icon|avatar|sprite|placeholder|\/ads?\//i.test(im.url);

/** Search other outlets for the same story and return their article images, best first. */
export async function findRelatedImages(input: { query: string; language: "vi" | "en"; excludeUrls: string[]; want: number }): Promise<{ images: RelatedImage[]; pages: number; errors: string[] }> {
  const errors: string[] = [];
  const skipHosts = new Set(input.excludeUrls.map(host).filter(Boolean));
  let hits: SearchHit[] = [];
  try {
    hits = await firecrawlSearch(input.query, { limit: 10, language: input.language });
  } catch (e) {
    errors.push(`firecrawl search: ${(e as Error).message.slice(0, 200)}`);
  }
  if (hits.length < 3) {
    try {
      hits = [...hits, ...(await bingNewsSearch(input.query, { language: input.language }))];
    } catch (e) {
      errors.push(`bing news: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  // One page per outlet, never the original, never private hosts.
  const seenHosts = new Set<string>();
  const pages = hits.filter((h) => {
    const hn = host(h.url);
    if (!hn || skipHosts.has(hn) || seenHosts.has(hn) || isPrivateHost(h.url)) return false;
    if (/bing\.com|msn\.com|google\.|facebook\.com|youtube\.com|tiktok\.com/i.test(hn)) return false;
    seenHosts.add(hn);
    return true;
  }).slice(0, MAX_PAGES);

  const images: RelatedImage[] = [];
  const seenUrl = new Set<string>();
  await Promise.all(
    pages.map(async (p) => {
      try {
        const { html, finalUrl } = await httpGetHtml(p.url, 15_000);
        const ex = extractFromHtml(html, finalUrl);
        const list = ex.images.filter(usableImage).slice(0, MAX_PER_PAGE);
        for (const im of list) {
          if (seenUrl.has(im.url)) continue;
          seenUrl.add(im.url);
          images.push({ ...im, pageUrl: finalUrl, pageTitle: ex.title ?? p.title, siteName: ex.siteName ?? host(finalUrl) });
        }
      } catch (e) {
        errors.push(`${host(p.url)}: ${(e as Error).message.slice(0, 120)}`);
      }
    }),
  );
  // Interleave outlets so the first N images do not all come from one page.
  const byPage = new Map<string, RelatedImage[]>();
  for (const im of images) byPage.set(im.pageUrl, [...(byPage.get(im.pageUrl) ?? []), im]);
  const interleaved: RelatedImage[] = [];
  for (let i = 0; interleaved.length < images.length; i++) for (const list of byPage.values()) if (list[i]) interleaved.push(list[i]);
  return { images: interleaved.slice(0, Math.max(input.want, 0) + 4), pages: pages.length, errors };
}

const ext = (url: string, fallback: string) => {
  const m = /\.(jpe?g|png|webp)(?:$|\?)/i.exec(url);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallback;
};

/** Download related-article images into R2 as project assets (deduped org-wide by content hash). */
export async function storeRelatedImages(
  images: RelatedImage[],
  opts: { buildId: string; max: number },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<{ assets: ChosenAsset[]; errors: string[] }> {
  const { organizationId, projectId } = ctx;
  const out: ChosenAsset[] = [];
  const errors: string[] = [];
  for (const [i, im] of images.entries()) {
    if (out.length >= opts.max) break;
    try {
      let key = r2Key.media(organizationId, projectId, `aroll/${opts.buildId}-r${i}.${ext(im.url, "jpg")}`);
      const dl = await downloadToR2(im.url, key, "image/jpeg");
      if (!dl.contentType.startsWith("image/")) {
        await deleteObject(key).catch(() => {});
        continue;
      }
      const dup = await withOrgContext(ctx, (tx) => tx.query.assets.findFirst({ where: and(eq(schema.assets.organizationId, organizationId), eq(schema.assets.hash, dl.hash)) }));
      if (dup) {
        await deleteObject(key).catch(() => {});
        // Same picture already in this project (e.g. a syndicated photo) → not a new visual.
        if (dup.projectId === projectId) continue;
        key = dup.r2Path;
      }
      const credit = im.siteName ? `Ảnh: ${im.siteName}` : null;
      const [row] = await withOrgContext(ctx, (tx) =>
        tx
          .insert(schema.assets)
          .values({ organizationId, projectId, origin: "article", provider: "related", sourceUrl: im.url, r2Path: key, hash: dl.hash, mime: dl.contentType, width: im.width ?? null, height: im.height ?? null, sizeBytes: dl.sizeBytes, licence: "related article (editorial)", attribution: credit, thumbnailUrl: im.url, meta: { buildId: opts.buildId, pageUrl: im.pageUrl, pageTitle: im.pageTitle, alt: im.alt ?? null } })
          .returning({ id: schema.assets.id }),
      );
      out.push({ assetId: row.id, key, kind: "image", durationSec: null, credit, provider: "related", thumbnailUrl: im.url });
    } catch (e) {
      errors.push(`${host(im.url)}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return { assets: out, errors };
}
