/** URL canonicalisation for duplicate detection and fetching (docs/PLAN.md §4.1). Pure, no I/O. */

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|zarsrc|spm|_hsenc|_hsmi|_ga|_gl|ref|ref_src|refsrc|source|cmpid|ocid|ncid|vn_source|vn_medium|vn_campaign|fb_source|share_type)$/i;

export function canonicalizeUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error("URL is empty");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL is not valid");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
  if (!u.hostname.includes(".")) throw new Error("URL must have a public hostname");

  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  u.username = "";
  u.password = "";
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";

  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!TRACKING_PARAM.test(k)) keep.append(k, v);
  keep.sort();
  u.search = keep.toString() ? `?${keep.toString()}` : "";

  // Collapse duplicate slashes and a trailing slash (but keep the root "/").
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  u.pathname = path;

  return u.toString();
}

/** Host without a leading "www." for display and grouping; "" without a URL (content typed in). */
export function displayHost(url: string | null) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A `next` parameter is only followed when it is a path inside the app. "//host" and "/\\host" are
 * protocol-relative URLs to browsers, so a leading slash alone does not make a value local.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/app") {
  return next && /^\/(?![/\\])/.test(next) && !/[\u0000-\u001f]/.test(next) ? next : fallback;
}

export function isPrivateHost(url: string) {
  try {
    const h = new URL(url).hostname;
    return (
      h === "localhost" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
      h === "::1" ||
      h.startsWith("[")
    );
  } catch {
    return true;
  }
}
