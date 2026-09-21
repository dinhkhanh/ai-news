/**
 * Pronunciation dictionary (docs/PLAN.md §4.4): text substitution before TTS.
 * Longest terms first so "TP. HCM" wins over "TP.HCM"-style overlaps; matches
 * are whole-token (bounded by whitespace/punctuation) and case-sensitive,
 * because abbreviations are case-significant (GDP vs gdp).
 */
export type Pronunciation = { term: string; replacement: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Private-use marks around a replacement while the text is being rewritten; never in real text. */
const OPEN = "\uE000";
const MID = "\uE001";
const CLOSE = "\uE002";
/** Spaces inside a replacement until every term is done, so no later (shorter) term matches inside it. */
const KEEP = "\uE003";

/**
 * The dictionary applied for the ear only. `spoken` is what the TTS reads ("Vi En Express"); `groups` says, word by
 * word of `splitWords(spoken)`, what the captions show instead: each replacement's spoken words fold back into the
 * term as written ("VnExpress", with the punctuation around it), every other word stands for itself (`n` = 1).
 */
export function pronounce(text: string, dict: Pronunciation[]): { spoken: string; applied: string[]; groups: Array<{ display: string; n: number }> } {
  const applied: string[] = [];
  const terms: string[] = [];
  let out = text;
  const sorted = [...dict].filter((d) => d.term.trim() && d.replacement.trim()).sort((a, b) => b.term.length - a.term.length);
  for (const { term, replacement } of sorted) {
    if (term === replacement) continue;
    const re = new RegExp(`(^|[\\s(\\[“"'‘])${escape(term)}(?=$|[\\s.,;:!?)\\]”"'’…])`, "gu");
    let hit = false;
    out = out.replace(re, (_m, pre: string) => {
      hit = true;
      terms.push(term);
      return `${pre}${OPEN}${terms.length - 1}${MID}${replacement.trim().replace(/\s+/g, KEEP)}${CLOSE}`;
    });
    if (hit) applied.push(term);
  }
  out = out.replaceAll(KEEP, " ");
  const groups: Array<{ display: string; n: number }> = [];
  let open: { display: string; n: number } | null = null;
  for (const token of splitWords(out)) {
    const plain = token.replace(/\uE000\d+\uE001/g, "").replace(/\uE002/g, "");
    if (!plain) continue;
    const start = /^(.*?)\uE000(\d+)\uE001/u.exec(token);
    if (start && !open) open = { display: `${start[1]}${terms[Number(start[2])]}`, n: 0 };
    if (open) {
      open.n++;
      const end = token.indexOf(CLOSE);
      if (end >= 0) {
        groups.push({ display: `${open.display}${token.slice(end + 1)}`, n: open.n });
        open = null;
      }
    } else groups.push({ display: plain, n: 1 });
  }
  if (open) groups.push(open);
  const spoken = out.replace(/\uE000\d+\uE001/g, "").replace(/\uE002/g, "");
  return { spoken, applied, groups };
}

/** Text substitution only (what the TTS reads); `pronounce` also says how to show it. */
export function applyPronunciations(text: string, dict: Pronunciation[]): { text: string; applied: string[] } {
  const r = pronounce(text, dict);
  return { text: r.spoken, applied: r.applied };
}

/**
 * Timed spoken words → timed caption words: the words of one replacement become the written term, from the start
 * of its first spoken word to the end of its last. Counts that do not add up leave the words as spoken.
 */
export function displayTimedWords<W extends { w: string; s: number; e: number }>(timed: W[], groups: Array<{ display: string; n: number }>): W[] {
  if (groups.reduce((a, g) => a + g.n, 0) !== timed.length) return timed;
  const out: W[] = [];
  let i = 0;
  for (const g of groups) {
    const first = timed[i];
    const last = timed[i + g.n - 1];
    out.push(g.n === 1 && first.w === g.display ? first : { ...first, w: g.display, e: last.e });
    i += g.n;
  }
  return out;
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

/** Longest term / replacement the dictionary form accepts. */
export const PRONUNCIATION_MAX = 120;

/**
 * Why a dictionary entry would not work, or null. Terms match whole tokens and case-sensitively (`pronounce`); a term
 * must not carry outer spaces and must differ from its reading.
 */
export function validPronunciation(term: string, replacement: string): string | null {
  if (!term.trim() || !replacement.trim()) return "Fill in both the word and how to read it";
  if (term !== term.trim()) return "The word must not start or end with a space";
  if (term === replacement.trim()) return "The reading is the same as the word";
  if (term.length > PRONUNCIATION_MAX || replacement.length > PRONUNCIATION_MAX) return `At most ${PRONUNCIATION_MAX} characters each`;
  return null;
}
