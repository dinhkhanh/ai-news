import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { readSecret } from "@/lib/vault";

/**
 * Network providers for article fetching (docs/PLAN.md §2 "Article fetch"):
 *   1. Cloudflare Browser Rendering REST (rendered HTML + screenshot)
 *   2. Plain HTTP GET (free; used when Browser Rendering is unavailable or fails)
 *   3. Firecrawl (paid fallback; admin-managed key + credit counter)
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36 ai-news/1.0";

async function integrationSecret(provider: string) {
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, provider) });
  if (!row?.enabled || !row.vaultRef) return { row, secret: null as string | null };
  return { row, secret: await readSecret(row.vaultRef) };
}

async function cloudflareAuth() {
  const e = env();
  const { secret } = await integrationSecret("cloudflare_browser");
  const token = secret ?? e.CLOUDFLARE_API_TOKEN ?? null;
  const accountId = e.CLOUDFLARE_ACCOUNT_ID ?? null;
  if (!token || !accountId) return null;
  return { token, accountId };
}

export async function browserRenderingAvailable() {
  return Boolean(await cloudflareAuth());
}

type CfJson<T> = { success: boolean; result?: T; errors?: Array<{ code?: number; message: string }> };

/** Browser Rendering rate-limits per minute; one delayed retry covers bursts (fetch + screenshot back to back). */
async function cfFetch(url: string, init: RequestInit, retryDelayMs = 12_000) {
  let res = await fetch(url, init);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    res = await fetch(url, init);
  }
  return res;
}

/** Rendered DOM after JS execution. */
export async function browserRenderContent(url: string, timeoutMs = 45_000): Promise<{ html: string; ms: number }> {
  const auth = await cloudflareAuth();
  if (!auth) throw new Error("Browser Rendering is not configured (CLOUDFLARE_ACCOUNT_ID / token)");
  const t0 = Date.now();
  const res = await cfFetch(`https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/browser-rendering/content`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      userAgent: UA,
      setExtraHTTPHeaders: { "Accept-Language": "vi,en;q=0.8" },
      gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 },
      rejectResourceTypes: ["image", "media", "font"],
      // Dismiss the most common consent overlays before the DOM is captured.
      addScriptTag: [{ content: "document.querySelectorAll('[id*=\"cookie\" i] button, [class*=\"consent\" i] button').forEach(b=>{try{b.click()}catch{}})" }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as CfJson<string> | null;
  if (!res.ok || !json?.success || typeof json.result !== "string") {
    throw new Error(`Browser Rendering content failed: HTTP ${res.status} ${json?.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
  }
  return { html: json.result, ms: Date.now() - t0 };
}

/** Vertical viewport screenshot (JPEG) of the article page, for the review view. */
export async function browserRenderScreenshot(url: string, timeoutMs = 45_000): Promise<{ jpeg: Buffer; ms: number }> {
  const auth = await cloudflareAuth();
  if (!auth) throw new Error("Browser Rendering is not configured");
  const t0 = Date.now();
  const res = await cfFetch(`https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/browser-rendering/screenshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      userAgent: UA,
      viewport: { width: 1080, height: 1920, deviceScaleFactor: 1 },
      screenshotOptions: { type: "jpeg", quality: 80, fullPage: false },
      // News pages never reach network idle (ads, trackers); DOM loaded + a short settle is enough for a review thumbnail.
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 25_000 },
      waitForTimeout: 2000,
      rejectResourceTypes: ["media", "font"],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) {
    const json = (await res.json().catch(() => null)) as CfJson<unknown> | null;
    throw new Error(`Browser Rendering screenshot failed: HTTP ${res.status} ${json?.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
  }
  return { jpeg: Buffer.from(await res.arrayBuffer()), ms: Date.now() - t0 };
}

/** Plain GET; enough for most server-rendered news sites and free. */
export async function httpGetHtml(url: string, timeoutMs = 20_000): Promise<{ html: string; finalUrl: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "vi,en;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/.test(ct)) throw new Error(`Not an HTML page (${ct || "unknown content type"})`);
  return { html: await res.text(), finalUrl: res.url || url, ms: Date.now() - t0 };
}

export type FirecrawlResult = {
  html: string | null;
  markdown: string | null;
  metadata: { title?: string; description?: string; language?: string; sourceURL?: string; ogImage?: string; author?: string; publishedTime?: string };
  ms: number;
};

export async function firecrawlAvailable() {
  const { row, secret } = await integrationSecret("firecrawl");
  return Boolean(secret) && (row?.creditsRemaining == null || row.creditsRemaining > 0);
}

export async function firecrawlScrape(url: string, timeoutMs = 60_000): Promise<FirecrawlResult> {
  const { row, secret } = await integrationSecret("firecrawl");
  if (!secret) throw new Error("Firecrawl is not enabled in /admin/integrations");
  if (row?.creditsRemaining != null && row.creditsRemaining <= 0) throw new Error("Firecrawl credits exhausted");
  const t0 = Date.now();
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: true, timeout: 45_000 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as
    | { success: boolean; error?: string; data?: { html?: string; markdown?: string; metadata?: FirecrawlResult["metadata"] } }
    | null;
  if (!res.ok || !json?.success || !json.data) throw new Error(`Firecrawl failed: HTTP ${res.status} ${json?.error ?? ""}`.trim());
  if (row?.creditsRemaining != null) {
    await db
      .update(schema.integrations)
      .set({ creditsRemaining: Math.max(0, row.creditsRemaining - 1) })
      .where(eq(schema.integrations.provider, "firecrawl"));
  }
  return { html: json.data.html ?? null, markdown: json.data.markdown ?? null, metadata: json.data.metadata ?? {}, ms: Date.now() - t0 };
}
