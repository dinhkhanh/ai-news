/**
 * Matching a brand kit to an article without a model: the keyword fallback of
 * the Haiku matcher (`llm/pick-brand-kit.ts`) and the parser for the keyword
 * field at /app/brand. Pure module (client + server + tests).
 */
export type KitCandidate = { id: string; name: string; description: string; keywords: string[]; isDefault: boolean };

export const MAX_KEYWORDS = 30;

/** Lower-case, Vietnamese diacritics folded ("Bóng đá" → "bong da"), punctuation to spaces. */
export function foldText(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "bóng đá, V-League; SEA Games" → ["bóng đá", "V-League", "SEA Games"] (deduplicated on the folded form). */
export function parseKeywords(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const k = raw.replace(/\s+/g, " ").trim().slice(0, 40);
    const f = foldText(k);
    if (f.length < 2 || seen.has(f)) continue;
    seen.add(f);
    out.push(k);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

function occurrences(haystack: string, needle: string) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Whole-word keyword hits; a hit in the title counts three times, and each keyword at most five times so one repeated word cannot win alone. */
export function keywordScore(kit: Pick<KitCandidate, "keywords">, article: { title: string | null; text: string }) {
  const title = ` ${foldText(article.title ?? "")} `;
  const body = ` ${foldText(article.text.slice(0, 8000))} `;
  const hits: string[] = [];
  let score = 0;
  for (const k of kit.keywords) {
    const needle = ` ${foldText(k)} `;
    if (needle.length < 4) continue;
    const s = Math.min(5, occurrences(title, needle) * 3 + occurrences(body, needle));
    if (s > 0) hits.push(k);
    score += s;
  }
  return { score, hits };
}

/** Best kit by keywords, or null when nothing scores at least 2 or the two best kits tie (then the default kit is the honest answer). */
export function pickKitByKeywords(kits: KitCandidate[], article: { title: string | null; text: string }): { id: string; reason: string } | null {
  const scored = kits.map((k) => ({ kit: k, ...keywordScore(k, article) })).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < 2 || (second && second.score === best.score)) return null;
  return { id: best.kit.id, reason: `từ khoá: ${best.hits.slice(0, 4).join(", ")}` };
}
