import type { TimedWord } from "./align";

export type CaptionChunk = { text: string; startMs: number; endMs: number; words: TimedWord[] };

const ENDS_CLAUSE = /[.,;:!?…]$/;

/**
 * Group timed words into caption chunks that fit a 1080-wide safe zone at
 * ~64 px: at most `maxWords` words / `maxChars` characters / `maxMs`, and
 * never across a sentence boundary. Vietnamese words are short, so the
 * character budget matters more than the word budget.
 */
export function chunkCaptions(words: TimedWord[], opts: { maxWords?: number; maxChars?: number; maxMs?: number; minMs?: number } = {}): CaptionChunk[] {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 26;
  const maxMs = opts.maxMs ?? 2400;
  const minMs = opts.minMs ?? 700;
  const out: CaptionChunk[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.w).join(" "), startMs: cur[0].s, endMs: cur[cur.length - 1].e, words: cur });
    cur = [];
  };
  for (const w of words) {
    const chars = cur.reduce((a, b) => a + b.w.length + 1, 0) + w.w.length;
    const span = cur.length ? w.e - cur[0].s : 0;
    if (cur.length && (cur.length >= maxWords || chars > maxChars || span > maxMs)) flush();
    cur.push(w);
    if (ENDS_CLAUSE.test(w.w) && cur.length >= 2) flush();
  }
  flush();
  // Keep very short chunks readable: extend to the next chunk's start.
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (out[i].endMs - out[i].startMs < minMs) out[i].endMs = Math.min(next ? next.startMs : out[i].startMs + minMs, out[i].startMs + minMs);
  }
  return out;
}
