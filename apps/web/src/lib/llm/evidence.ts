/** Evidence matching helpers (pure). */
const fold = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[“”"'‘’«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** True when the quoted evidence appears in the article text (whitespace/quote-insensitive). */
export function evidenceAppears(article: string, evidence: string | null) {
  if (!evidence) return false;
  const a = fold(article);
  const e = fold(evidence);
  if (!e) return false;
  if (a.includes(e)) return true;
  // Models sometimes join two sentences; accept if every sentence-sized chunk appears.
  const chunks = e.split(/(?<=[.!?…])\s+/).filter((c) => c.length > 12);
  return chunks.length > 1 && chunks.every((c) => a.includes(c));
}
