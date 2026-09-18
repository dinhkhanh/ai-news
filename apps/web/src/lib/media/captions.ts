import type { TimedWord } from "./align";
import { markCompounds } from "./compounds";

export type CaptionChunk = { text: string; startMs: number; endMs: number; words: TimedWord[] };

const ENDS_CLAUSE = /[.,;:!?…]["'”’)\]]*$/;
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/;
/** Titles written with a full stop that do not end a sentence ("TP. Hồ Chí Minh"). */
const ABBREVIATIONS = new Set(["tp", "ts", "ths", "pgs", "gs", "bs", "mr", "mrs", "ms", "dr", "st", "vs"]);

/** Word `i` closes a sentence: final punctuation, and the next word does not carry on in lower case ("Và rồi… im lặng."). */
export function endsSentence(words: Array<{ w: string }>, i: number) {
  const w = words[i].w;
  if (!ENDS_SENTENCE.test(w)) return false;
  if (ABBREVIATIONS.has(w.replace(/[^\p{L}]/gu, "").toLowerCase()) && /\.$/.test(w)) return false;
  const next = words[i + 1]?.w.replace(/^[^\p{L}\p{N}]+/u, "");
  return !next || !/^\p{Ll}/u.test(next);
}

const textOf = (words: TimedWord[]) => words.map((w) => w.w).join(" ");

/**
 * Group timed words into caption chunks that fit a 1080-wide safe zone at
 * ~64 px: at most `maxWords` words / `maxChars` characters / `maxMs`.
 * Vietnamese words are short, so the character budget matters more than the
 * word budget. Three rules come before the budgets:
 * - a chunk never holds words of two sentences (the last word of a sentence
 *   never shares a line with the start of the next one);
 * - no chunk is a single word, unless the sentence is one word;
 * - a compound word / name / figure (`compounds.ts`) is never split. The
 *   chunk's words carry `j` (joined to the next word) so the composition
 *   keeps them on one line too (`captionLines`).
 * Each sentence is partitioned as a whole (cheapest split), preferring breaks
 * at clause punctuation; a chunk may run one word / a few characters over the
 * budget when that is the only way to avoid a lone word.
 */
export function chunkCaptions(input: TimedWord[], opts: { maxWords?: number; maxChars?: number; maxMs?: number; minMs?: number; lineChars?: number } = {}): CaptionChunk[] {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 26;
  const maxMs = opts.maxMs ?? 2400;
  const minMs = opts.minMs ?? 700;
  // What one line surely holds: a chunk of up to three words cannot be balanced over two lines without a lone word.
  const lineChars = opts.lineChars ?? 18;
  const words = markCompounds(input);
  const out: CaptionChunk[] = [];

  const chunkSentence = (from: number, to: number) => {
    // Units: runs of joined words, [start, end).
    const units: Array<[number, number]> = [];
    for (let i = from; i < to; ) {
      let k = i;
      while (k < to - 1 && words[k].j) k++;
      units.push([i, k + 1]);
      i = k + 1;
    }
    const n = units.length;
    const cost = (a: number, b: number) => {
      const part = words.slice(units[a][0], units[b - 1][1]);
      const chars = textOf(part).length;
      const span = part[part.length - 1].e - part[0].s;
      const atClause = b === n || ENDS_CLAUSE.test(part[part.length - 1].w);
      // A pause in the voice is a free place to change captions.
      let c = atClause && b < n ? 2 : 10;
      if (b - a > 1 && (part.length > maxWords || chars > maxChars || span > maxMs)) c += part.length <= maxWords + 1 && chars <= maxChars + 4 && span <= maxMs * 1.25 ? 60 : 10_000;
      if (part.length === 1 && to - from > 1) c += 500;
      if (!atClause) c += part.length === 2 ? 12 : 8;
      // …and a caption that runs over a pause reads against the voice.
      if (part.slice(0, -1).some((w) => ENDS_CLAUSE.test(w.w))) c += 6;
      if (part.length <= 3 && chars > lineChars) c += 30;
      return c;
    };
    const best = new Array<number>(n + 1).fill(Infinity);
    const prev = new Array<number>(n + 1).fill(0);
    best[0] = 0;
    for (let b = 1; b <= n; b++) {
      for (let a = Math.max(0, b - maxWords - 1); a < b; a++) {
        const c = best[a] + cost(a, b);
        if (c < best[b]) {
          best[b] = c;
          prev[b] = a;
        }
      }
    }
    const cuts: number[] = [];
    for (let b = n; b > 0; b = prev[b]) cuts.unshift(b);
    let a = 0;
    for (const b of cuts) {
      const part = words.slice(units[a][0], units[b - 1][1]);
      // A join never leaves the chunk.
      const last = part[part.length - 1];
      if (last.j) part[part.length - 1] = { w: last.w, s: last.s, e: last.e };
      out.push({ text: textOf(part), startMs: part[0].s, endMs: last.e, words: part });
      a = b;
    }
  };

  let from = 0;
  for (let i = 0; i < words.length; i++) {
    if (i === words.length - 1 || endsSentence(words, i)) {
      chunkSentence(from, i + 1);
      from = i + 1;
    }
  }
  // Keep very short chunks readable: extend to the next chunk's start.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (out[i].endMs - out[i].startMs < minMs) out[i].endMs = Math.min(next ? next.startMs : out[i].startMs + minMs, out[i].startMs + minMs);
  }
  return out;
}
