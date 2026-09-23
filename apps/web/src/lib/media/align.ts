/**
 * Word timing alignment (docs/PLAN.md §4.4 "word timings per voice type").
 * Chirp 3 HD voices give no timepoints, so the synthesised audio goes through
 * Speech-to-Text and its words are aligned back onto the script words with a
 * longest-common-subsequence match; unmatched script words are interpolated
 * between their matched neighbours. Falls back to a proportional spread when
 * the transcript is unusable.
 */
/** `j`: joined to the next word (compound word, name, figure; set by `markCompounds`), captions never break between the two. */
export type TimedWord = { w: string; s: number; e: number; j?: boolean };
export type SttWord = { word: string; startMs: number; endMs: number };

export function normaliseToken(t: string) {
  return t
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The voice read (part of) the text more than once: some run of up to three script words is heard more often than the
 * script says it. Gemini-TTS does this on short inputs ("A. B." comes back as "A. B. B." or "A. B. A. B.").
 */
export function readTwice(scriptWords: string[], stt: SttWord[]) {
  const script = scriptWords.map(normaliseToken).filter(Boolean);
  const heard = stt.map((w) => normaliseToken(w.word)).filter(Boolean);
  const n = Math.min(3, script.length);
  if (n === 0 || heard.length <= script.length) return false;
  const grams = (t: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n).join(" ");
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const inScript = grams(script);
  for (const [g, c] of grams(heard)) if (c > (inScript.get(g) ?? c)) return true;
  return false;
}

/** Spread script words over [0, durationMs] weighted by character length (min 120 ms each). */
export function proportionalTimings(words: string[], durationMs: number, offsetMs = 0): TimedWord[] {
  const weights = words.map((w) => Math.max(1, normaliseToken(w).length));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = offsetMs;
  return words.map((w, i) => {
    const len = Math.max(120, (durationMs * weights[i]) / total);
    const s = Math.round(t);
    t += len;
    return { w, s, e: Math.round(Math.min(offsetMs + durationMs, t)) };
  });
}

function lcs(a: string[], b: string[]) {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export type AlignResult = { words: TimedWord[]; matched: number; method: "stt" | "proportional" };

/**
 * Align script words to STT words. `durationMs` is the audio length (bounds the
 * result); `offsetMs` shifts everything (scene start within the whole VO).
 */
export function alignWords(scriptWords: string[], stt: SttWord[], durationMs: number, offsetMs = 0): AlignResult {
  if (scriptWords.length === 0) return { words: [], matched: 0, method: "proportional" };
  const a = scriptWords.map(normaliseToken);
  const b = stt.map((w) => normaliseToken(w.word));
  const pairs = lcs(a, b);
  // Need a reasonable share of matches, otherwise the transcript is garbage (wrong language, silence).
  if (pairs.length < Math.max(2, Math.ceil(scriptWords.length * 0.4))) {
    return { words: proportionalTimings(scriptWords, durationMs, offsetMs), matched: pairs.length, method: "proportional" };
  }
  const start = new Array<number | null>(scriptWords.length).fill(null);
  const end = new Array<number | null>(scriptWords.length).fill(null);
  for (const [i, j] of pairs) {
    start[i] = stt[j].startMs;
    end[i] = stt[j].endMs;
  }
  // Interpolate gaps: each run of unmatched words shares the interval between neighbours.
  let i = 0;
  while (i < scriptWords.length) {
    if (start[i] !== null) {
      i++;
      continue;
    }
    let k = i;
    while (k < scriptWords.length && start[k] === null) k++;
    const from = i > 0 ? (end[i - 1] as number) : 0;
    const to = k < scriptWords.length ? (start[k] as number) : durationMs;
    const seg = proportionalTimings(scriptWords.slice(i, k), Math.max(120 * (k - i), to - from), from);
    for (let x = i; x < k; x++) {
      start[x] = seg[x - i].s;
      end[x] = Math.min(seg[x - i].e, Math.max(seg[x - i].s + 60, to));
    }
    i = k;
  }
  const words: TimedWord[] = scriptWords.map((w, idx) => {
    const s = Math.max(0, Math.min(durationMs, start[idx] as number));
    const e = Math.max(s + 60, Math.min(durationMs, end[idx] as number));
    return { w, s: Math.round(s + offsetMs), e: Math.round(e + offsetMs) };
  });
  // Enforce monotonic, non-overlapping times.
  for (let x = 1; x < words.length; x++) {
    if (words[x].s < words[x - 1].e) words[x].s = words[x - 1].e;
    if (words[x].e < words[x].s + 60) words[x].e = words[x].s + 60;
  }
  return { words, matched: pairs.length, method: "stt" };
}
