/**
 * Pronunciation dictionary (docs/PLAN.md §4.4): text substitution before TTS.
 * Longest terms first so "TP. HCM" wins over "TP.HCM"-style overlaps; matches
 * are whole-token (bounded by whitespace/punctuation) and case-sensitive,
 * because abbreviations are case-significant (GDP vs gdp).
 */
export type Pronunciation = { term: string; replacement: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function applyPronunciations(text: string, dict: Pronunciation[]): { text: string; applied: string[] } {
  const applied: string[] = [];
  let out = text;
  const sorted = [...dict].filter((d) => d.term.trim()).sort((a, b) => b.term.length - a.term.length);
  for (const { term, replacement } of sorted) {
    if (term === replacement) continue;
    const re = new RegExp(`(^|[\\s(\\[“"'‘])${escape(term)}(?=$|[\\s.,;:!?)\\]”"'’…])`, "gu");
    let hit = false;
    out = out.replace(re, (_m, pre: string) => {
      hit = true;
      return `${pre}${replacement}`;
    });
    if (hit) applied.push(term);
  }
  return { text: out, applied };
}

/** Escape text for SSML (Neural2 voices). */
export function ssmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Tokenise voice-over text into spoken words, keeping punctuation attached (for captions). */
export function splitWords(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
