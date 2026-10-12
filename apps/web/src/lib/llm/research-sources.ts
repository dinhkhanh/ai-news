/**
 * Topic projects (`projects.source_kind = "topic"`): the user gives keywords, a topic or directions instead of a link,
 * and the fetch step researches it on the web (`llm/research.ts`). Pure helpers, no I/O (tested in
 * research-sources.test.ts): brief limits, the sources the web tools really returned, and the credit line.
 */

/** A brief shorter than this is not enough to search for; longer than the max is cut. */
export const BRIEF_MIN_CHARS = 3;
export const BRIEF_MAX_CHARS = 2000;

/** Pages kept on an article (project page list); the first ones are the most important. */
export const SOURCES_MAX = 12;

/** Outlets named in the credit (outro “Nguồn: …”, publish source line); the rest are on the project page. */
export const CREDIT_MAX_OUTLETS = 3;

export type ResearchSource = { url: string; title: string | null; siteName: string | null; pageAge?: string | null };

/** The brief as stored: line breaks normalised, blank runs collapsed, cut at `BRIEF_MAX_CHARS`. */
export function normaliseBrief(input: string) {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, BRIEF_MAX_CHARS)
    .trim();
}

/** Working title until the research names the story: the brief's first line, about one headline long. */
export function briefTitle(brief: string) {
  const line = brief.split("\n")[0].trim();
  if (line.length <= 90) return line;
  const cut = line.slice(0, 90);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

/** The form of a URL two sources are compared by: no scheme, `www.`, fragment, tracking query or trailing slash. */
export function sourceKey(url: string) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ocid$)/i.test(k)) u.searchParams.delete(k);
    const query = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./i, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${query ? `?${query}` : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Host without `www.`, or null for something that is not a web address. */
export function hostOf(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./i, "").toLowerCase() : null;
  } catch {
    return null;
  }
}

type Block = { type: string; [k: string]: unknown };

/**
 * Every page the web tools actually returned in a research turn: web search results, fetched pages, the citations
 * of the text and links printed by the code the dynamic-filtering web tools run, deduplicated by `sourceKey` in the
 * order they appeared. Tool errors (an object instead of a list / page) are skipped. The model's own source list is
 * only trusted where it matches one of these.
 */
export function collectSources(content: readonly Block[]): ResearchSource[] {
  const out = new Map<string, ResearchSource>();
  const add = (url: unknown, title: unknown, pageAge?: unknown) => {
    if (typeof url !== "string" || !hostOf(url)) return;
    const key = sourceKey(url);
    const prev = out.get(key);
    const t = typeof title === "string" && title.trim() ? title.trim() : null;
    if (prev) {
      if (!prev.title && t) prev.title = t;
      return;
    }
    out.set(key, { url, title: t, siteName: null, pageAge: typeof pageAge === "string" ? pageAge : null });
  };
  for (const b of content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content as Block[]) if (r?.type === "web_search_result") add(r.url, r.title, r.page_age);
    } else if (b.type === "web_fetch_tool_result" && b.content && typeof b.content === "object" && (b.content as Block).type === "web_fetch_result") {
      const page = b.content as Block & { content?: { title?: unknown } };
      add(page.url, page.content?.title);
    } else if (b.type === "text" && Array.isArray(b.citations)) {
      // Web citations (`web_search_result_location` …) carry the page's url and title.
      for (const c of b.citations as Block[]) if (c && typeof c.url === "string") add(c.url, c.title);
    } else if (b.type.endsWith("code_execution_tool_result") && b.content && typeof b.content === "object") {
      const stdout = (b.content as { stdout?: unknown }).stdout;
      if (typeof stdout === "string") for (const m of stdout.matchAll(/https?:\/\/[^\s"'<>()[\]{}]+/g)) add(m[0].replace(/[.,;:!?]+$/, ""), null);
    }
  }
  return [...out.values()];
}

/**
 * The sources the article says it used, kept only when the web tools really returned that page (no invented links),
 * with the model's outlet name; when it names none that match, every page found is kept so the credit is never empty.
 */
export function usedSources(claimed: ReadonlyArray<{ url: string; outlet?: string | null; title?: string | null }>, found: readonly ResearchSource[]): ResearchSource[] {
  const byKey = new Map(found.map((s) => [sourceKey(s.url), s]));
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const c of claimed) {
    const key = sourceKey(c.url);
    const hit = byKey.get(key);
    if (!hit || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...hit, title: hit.title ?? c.title?.trim() ?? null, siteName: c.outlet?.trim() || hit.siteName || null });
  }
  return (out.length ? out : found.map((s) => ({ ...s }))).slice(0, SOURCES_MAX);
}

/** Credit for the outro and the publish text: up to `CREDIT_MAX_OUTLETS` distinct outlet names (host when unnamed). */
export function creditLine(sources: readonly ResearchSource[]) {
  const names: string[] = [];
  for (const s of sources) {
    const name = s.siteName?.trim() || hostOf(s.url);
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  if (!names.length) return null;
  return names.length > CREDIT_MAX_OUTLETS ? `${names.slice(0, CREDIT_MAX_OUTLETS).join(", ")}…` : names.join(", ");
}
