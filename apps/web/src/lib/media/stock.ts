import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { putObject } from "@/lib/r2";
import { readSecret } from "@/lib/vault";

/**
 * Stock B-roll providers (docs/PLAN.md §4.3): Pexels + Pixabay video search
 * with admin-managed keys. Results are normalised to one candidate shape so
 * ranking, download and licence bookkeeping do not care about the provider.
 */
export type StockCandidate = {
  provider: "pexels" | "pixabay";
  providerId: string;
  pageUrl: string;
  thumbnailUrl: string;
  downloadUrl: string;
  width: number;
  height: number;
  durationSec: number;
  author: string | null;
  licence: string;
  licenceUrl: string;
  searchTerm: string;
};

async function providerKey(provider: "pexels" | "pixabay") {
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, provider) });
  if (!row?.enabled || !row.vaultRef) return null;
  return readSecret(row.vaultRef);
}

export async function stockProvidersAvailable() {
  const [pexels, pixabay] = await Promise.all([providerKey("pexels"), providerKey("pixabay")]);
  return { pexels: Boolean(pexels), pixabay: Boolean(pixabay) };
}

type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user?: { name?: string };
  video_files: Array<{ link: string; quality: string; width: number | null; height: number | null; fps: number | null; file_type: string }>;
};

/** Prefer a 1080-wide portrait MP4; otherwise the tallest MP4 ≤ 2160 px. */
function pickPexelsFile(v: PexelsVideo) {
  const mp4 = v.video_files.filter((f) => f.file_type === "video/mp4" && f.width && f.height);
  const portrait = mp4.filter((f) => (f.height ?? 0) > (f.width ?? 0));
  const pool = portrait.length ? portrait : mp4;
  const scored = pool
    .filter((f) => (f.height ?? 0) <= 2160 && (f.width ?? 0) <= 2160)
    .sort((a, b) => Math.abs((a.width ?? 0) - 1080) + Math.abs((a.height ?? 0) - 1920) - (Math.abs((b.width ?? 0) - 1080) + Math.abs((b.height ?? 0) - 1920)));
  return scored[0] ?? null;
}

async function searchPexels(term: string, key: string, perPage: number): Promise<StockCandidate[]> {
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", term);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("size", "medium");
  url.searchParams.set("per_page", String(perPage));
  const res = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const json = (await res.json()) as { videos: PexelsVideo[] };
  return json.videos
    .map((v): StockCandidate | null => {
      const f = pickPexelsFile(v);
      if (!f) return null;
      return {
        provider: "pexels" as const,
        providerId: String(v.id),
        pageUrl: v.url,
        thumbnailUrl: v.image,
        downloadUrl: f.link,
        width: f.width ?? v.width,
        height: f.height ?? v.height,
        durationSec: v.duration,
        author: v.user?.name ?? null,
        licence: "Pexels License",
        licenceUrl: "https://www.pexels.com/license/",
        searchTerm: term,
      };
    })
    .filter((c): c is StockCandidate => c !== null);
}

type PixabayHit = {
  id: number;
  pageURL: string;
  duration: number;
  user?: string;
  videos: Record<"large" | "medium" | "small" | "tiny", { url: string; width: number; height: number; size: number; thumbnail?: string }>;
};

async function searchPixabay(term: string, key: string, perPage: number): Promise<StockCandidate[]> {
  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", term.slice(0, 100));
  url.searchParams.set("video_type", "film");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", String(Math.max(3, perPage)));
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
  const json = (await res.json()) as { hits: PixabayHit[] };
  return json.hits
    .map((h): StockCandidate | null => {
      // medium is 1080p-class for both orientations; small is the 720p fallback.
      const f = h.videos.medium?.url ? h.videos.medium : h.videos.small;
      if (!f?.url) return null;
      return {
        provider: "pixabay" as const,
        providerId: String(h.id),
        pageUrl: h.pageURL,
        thumbnailUrl: f.thumbnail ?? h.videos.tiny?.thumbnail ?? "",
        downloadUrl: f.url,
        width: f.width,
        height: f.height,
        durationSec: h.duration,
        author: h.user ?? null,
        licence: "Pixabay Content License",
        licenceUrl: "https://pixabay.com/service/license-summary/",
        searchTerm: term,
      };
    })
    .filter((c): c is StockCandidate => c !== null && Boolean(c.thumbnailUrl));
}

/**
 * Search every enabled provider for each term. Portrait clips first, then by
 * closeness to the wanted duration. Returns [] when no provider is configured.
 */
export async function searchStock(terms: string[], opts: { perTerm?: number; wantSec?: number } = {}): Promise<{ candidates: StockCandidate[]; errors: string[] }> {
  const perTerm = opts.perTerm ?? 5;
  const [pexels, pixabay] = await Promise.all([providerKey("pexels"), providerKey("pixabay")]);
  const errors: string[] = [];
  const all: StockCandidate[] = [];
  await Promise.all(
    terms.flatMap((term) => [
      pexels ? searchPexels(term, pexels, perTerm).then((r) => all.push(...r)).catch((e) => errors.push(`pexels "${term}": ${(e as Error).message}`)) : null,
      pixabay ? searchPixabay(term, pixabay, perTerm).then((r) => all.push(...r)).catch((e) => errors.push(`pixabay "${term}": ${(e as Error).message}`)) : null,
    ]),
  );
  const seen = new Set<string>();
  const unique = all.filter((c) => {
    const k = `${c.provider}:${c.providerId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const want = opts.wantSec ?? 8;
  unique.sort((a, b) => {
    const pa = a.height > a.width ? 0 : 1;
    const pb = b.height > b.width ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const da = a.durationSec >= want ? 0 : 1;
    const db_ = b.durationSec >= want ? 0 : 1;
    return da - db_;
  });
  return { candidates: unique, errors };
}

const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

/** Download a remote file into R2 and return its hash/size so callers can dedupe org-wide. */
export async function downloadToR2(url: string, key: string, contentTypeHint = "video/mp4") {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "ai-news/1.0" } });
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url.slice(0, 120)}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`file too large (${Math.round(len / 1e6)} MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`file too large (${Math.round(buf.byteLength / 1e6)} MB)`);
  const hash = createHash("sha256").update(buf).digest("hex");
  const contentType = res.headers.get("content-type")?.split(";")[0] || contentTypeHint;
  await putObject(key, buf, contentType);
  return { hash, sizeBytes: buf.byteLength, contentType };
}
