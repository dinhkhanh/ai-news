import { VI_COMPOUNDS_PACKED } from "./vi-compounds";

/**
 * Which caption words belong together: `joins[i]` = word `i` and word `i + 1`
 * are one unit (a compound word such as "thành phố", a name such as
 * "Hồ Chí Minh", a figure such as "5 tỷ đồng"), so a caption never breaks the
 * line or the chunk between them. Pure: a dictionary lookup plus two
 * heuristics; a wrong join only removes one break opportunity.
 */

/** Words the dictionary lacks; lower case. */
const EXTRA_COMPOUNDS = ["việt nam", "người dùng", "mạng xã hội", "trực tuyến", "điện tử", "tiền điện tử", "tiền ảo", "xe điện", "chuyển đổi số", "khởi nghiệp", "nhà đầu tư", "thị trường", "chứng khoán"];

const MAX_DICT_WORDS = 3;
const MAX_NAME_WORDS = 4;

const TONE_MARKS = /[\u0300\u0301\u0303\u0309\u0323]/g;
/** Same key for "hòa" and "hoà": the tone mark moves to the end of the syllable. */
function toneKey(syllable: string) {
  const d = syllable.normalize("NFD");
  const tone = d.match(TONE_MARKS)?.[0] ?? "";
  return d.replace(TONE_MARKS, "") + tone;
}
const phraseKey = (syllables: string[]) => syllables.map(toneKey).join(" ");

let dict: Set<string> | null = null;
function dictionary() {
  if (dict) return dict;
  dict = new Set<string>();
  for (const group of VI_COMPOUNDS_PACKED.split("|")) {
    const at = group.indexOf(":");
    const first = group.slice(0, at);
    for (const rest of group.slice(at + 1).split(",")) dict.add(phraseKey([first, ...rest.split(" ")]));
  }
  for (const w of EXTRA_COMPOUNDS) dict.add(phraseKey(w.split(" ")));
  return dict;
}

const LEADING = /^[("'“‘[]+/;
const TRAILING = /[)"'”’\].,;:!?…]+$/;
/** The word without the punctuation attached to it. */
const core = (w: string) => w.replace(LEADING, "").replace(TRAILING, "");
/** Punctuation after the word: nothing may be joined across it (a bare "%" is part of the figure). */
const closes = (w: string) => TRAILING.test(w);
const opens = (w: string) => LEADING.test(w);

const isNumber = (c: string) => /^\d[\d.,]*%?$/.test(c);
/** Capitalised, or with a capital inside ("iPhone", "eBay"). */
const isName = (c: string) => /^\p{L}*\p{Lu}/u.test(c);
/** Seldom the start of a compound when the next words form one too. */
const FUNCTION_WORDS = new Set(["của", "là", "và", "có", "các", "những", "một", "cho", "với", "trong", "ngoài", "để", "đã", "sẽ", "đang", "ở", "tại", "từ", "về", "theo", "không", "được", "bị", "này", "đó", "khi", "nhưng", "hay", "hoặc", "cũng", "rất", "ra", "vào", "lên", "xuống", "đến", "người"]);
const BEFORE_NUMBER = new Set(["năm", "tháng", "ngày", "quý", "thứ", "số", "lúc", "mùng", "top"]);
const MAGNITUDES = new Set(["tỷ", "tỉ", "triệu", "nghìn", "ngàn", "trăm", "chục", "billion", "million", "thousand"]);
const UNITS = new Set(["%", "usd", "vnd", "đồng", "đô", "euro", "yên", "km", "m", "cm", "mm", "kg", "g", "tấn", "ha", "giờ", "phút", "giây", "tuổi", "độ", "lần", "percent", "dollars"]);

export function compoundJoins(words: string[]): boolean[] {
  const n = words.length;
  const joins = new Array<boolean>(n).fill(false);
  const cores = words.map((w) => core(w).normalize("NFC"));
  const lower = cores.map((c) => c.toLowerCase());
  /** Words `i..i+len` can be one unit: no punctuation inside it. */
  const open = (i: number, len: number) => {
    for (let k = i; k < i + len; k++) {
      if (k < i + len - 1 && closes(words[k])) return false;
      if (k > i && opens(words[k])) return false;
    }
    return true;
  };
  /** Every dictionary word that starts at `i`, as lengths. */
  const dictLens = (i: number) => {
    const lens: number[] = [];
    for (let len = 2; len <= Math.min(MAX_DICT_WORDS, n - i); len++) {
      const part = lower.slice(i, i + len);
      if (part.every((p) => /^\p{L}+$/u.test(p)) && open(i, len) && dictionary().has(phraseKey(part))) lens.push(len);
    }
    return lens;
  };
  const nameLen = (i: number) => {
    let len = 0;
    while (i + len < n && len < MAX_NAME_WORDS && isName(cores[i + len]) && open(i, len + 1)) len++;
    // "iPhone 17", "Boeing 737": a model number belongs to the name.
    if (len >= 1 && len < MAX_NAME_WORDS && i + len < n && isNumber(cores[i + len]) && open(i, len + 1)) len++;
    return Math.max(1, len);
  };
  const figureLen = (i: number) => {
    // "năm 2026", then "5" + "tỷ" + "đồng".
    let at = i;
    if (BEFORE_NUMBER.has(lower[at]) && at + 1 < n && isNumber(cores[at + 1])) at++;
    if (!isNumber(cores[at])) return 1;
    let end = at + 1;
    if (end < n && MAGNITUDES.has(lower[end])) end++;
    if (end < n && UNITS.has(lower[end])) end++;
    while (end - i > 1 && !open(i, end - i)) end--;
    return end - i;
  };
  // Best segmentation of the whole run, not the first match: "của công ty" is "của" + "công ty" although "của công" is a word.
  // A unit of `len` words scores len², a dictionary word that starts with a function word slightly less.
  const score = new Array<number>(n + 1).fill(0);
  const take = new Array<number>(n).fill(1);
  for (let i = n - 1; i >= 0; i--) {
    score[i] = -Infinity;
    const options: Array<[number, number]> = [[1, 1], ...dictLens(i).map((len): [number, number] => [len, len * len - (FUNCTION_WORDS.has(lower[i]) ? 0.5 : 0)])];
    for (const len of [nameLen(i), figureLen(i)]) if (len > 1) options.push([len, len * len]);
    for (const [len, points] of options) {
      if (points + score[i + len] > score[i]) {
        score[i] = points + score[i + len];
        take[i] = len;
      }
    }
  }
  for (let i = 0; i < n; i += take[i]) for (let k = i; k < i + take[i] - 1; k++) joins[k] = true;
  return joins;
}

/** The same words with `j` set on every word that is joined to the next one. */
export function markCompounds<T extends { w: string }>(words: T[]): Array<T & { j?: boolean }> {
  const joins = compoundJoins(words.map((w) => w.w));
  return words.map((w, i) => {
    const next: T & { j?: boolean } = { ...w };
    if (joins[i]) next.j = true;
    else delete next.j;
    return next;
  });
}
