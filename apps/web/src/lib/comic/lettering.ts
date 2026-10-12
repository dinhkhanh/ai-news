import { BALLOON_LINE_HEIGHT, BALLOON_PADDING, pageGeometry, pictureToPage, type Balloon, type ComicFont, type LetteringKind, type Panel, type ReadingDirection, type Rect } from "@ai-news/video/comic";

/**
 * Automatic lettering (docs/COMIC.md §9). Pure and tested. Balloons are data drawn by the page renderer, never part
 * of the picture: this module sizes them from their text, places them in their panel in reading order away from the
 * faces Cloud Vision found and from each other, and points the tail at the speaker. Balloons a person moved
 * (`manual`) are left alone and treated as obstacles.
 */

/** Average glyph width as a share of the font size (Vietnamese text with diacritics, measured on samples). */
const CHAR_WIDTH: Record<ComicFont, number> = { itim: 0.5, bevietnam: 0.56 };
/** Smallest size a balloon may shrink to, as a share of the base size, before it is flagged as too long. */
export const MIN_FONT_SCALE = 0.72;

/** Base lettering size for a page width (32 px on an A4 page of 1240 px). */
export const baseFontSize = (pageWidth: number) => Math.round(pageWidth * 0.026);
export const fontSizeFor = (kind: LetteringKind, pageWidth: number) => Math.round(baseFontSize(pageWidth) * (kind === "sfx" ? 2 : kind === "caption" ? 0.9 : 1));

const OVAL: LetteringKind[] = ["speech", "thought", "whisper"];

/** Greedy word wrap on an estimated character budget per line. A word longer than the budget gets its own line. */
export function wrapWords(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Box of a balloon for its text at `fontSize`, wrapped to fit `maxWidth`. */
export function balloonBox(text: string, kind: LetteringKind, fontSize: number, maxWidth: number, font: ComicFont) {
  const k = CHAR_WIDTH[font] * (kind === "shout" || kind === "sfx" ? 1.08 : 1);
  const padX = kind === "sfx" ? 0 : fontSize * BALLOON_PADDING;
  const padY = kind === "sfx" ? 0 : fontSize * 0.5;
  const oval = OVAL.includes(kind) ? 1.28 : 1;
  const usable = Math.max(fontSize * k * 4, maxWidth / oval - 2 * padX);
  const lines = wrapWords(text, Math.max(4, Math.floor(usable / (fontSize * k))));
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const w = (longest * fontSize * k + 2 * padX) * oval;
  const h = (lines.length * fontSize * BALLOON_LINE_HEIGHT + 2 * padY) * (oval > 1 ? 1.22 : 1);
  return { w: Math.round(w), h: Math.round(h), lines: lines.length };
}

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function overlap(a: Rect, b: Rect) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });
const inRect = (p: { x: number; y: number }, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

/** Whether the straight line from a to b passes through r (sampled: balloons are large next to a tail's step). */
export function segmentHits(a: { x: number; y: number }, b: { x: number; y: number }, r: Rect, steps = 16) {
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (inRect({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, r)) return true;
  }
  return false;
}
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Face boxes of the panel's picture in page px, following the renderer's cover fit and the panel's crop. */
export function facesOnPage(panel: Panel): Rect[] {
  const img = panel.image;
  if (!img?.faces?.length || !img.width || !img.height) return [];
  return img.faces.map((f) => {
    const a = pictureToPage(panel.rect, img, panel.crop, { x: f.x, y: f.y });
    const b = pictureToPage(panel.rect, img, panel.crop, { x: f.x + f.w, y: f.y + f.h });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  });
}

/** Where a speaker is in the panel: their face when the faces can be matched to the script's positions, else a point on their side. */
export function speakerPoint(panel: Panel, speaker: string | null): { x: number; y: number } | null {
  if (!speaker) return null;
  const chars = panel.script.characters.filter((c) => c.position !== "background");
  const me = panel.script.characters.find((c) => c.ref === speaker);
  if (!me) return null;
  const { x, y, w, h } = panel.rect;
  const faces = facesOnPage(panel).sort((a, b) => a.x - b.x);
  const order = ["left", "center", "right"];
  if (faces.length && me.position !== "background") {
    const ranked = [...chars].sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
    const i = ranked.findIndex((c) => c.ref === speaker);
    let face = faces.length === ranked.length ? faces[i] : undefined;
    if (!face) {
      // Not every character was found: take the face nearest to where the script puts this one, if it is on their side.
      const want = x + w * (me.position === "left" ? 0.25 : me.position === "right" ? 0.75 : 0.5);
      const near = [...faces].sort((a, b) => Math.abs(a.x + a.w / 2 - want) - Math.abs(b.x + b.w / 2 - want))[0];
      if (near && Math.abs(near.x + near.w / 2 - want) < w * 0.25) face = near;
    }
    if (face) return { x: face.x + face.w / 2, y: face.y + face.h * 0.75 };
  }
  const fx = me.position === "left" ? 0.25 : me.position === "right" ? 0.75 : 0.5;
  return { x: x + w * fx, y: y + h * (me.position === "background" ? 0.45 : 0.62) };
}

/** Tail tip: towards the speaker, stopping short of their face and never longer than a share of the panel. */
export function tailTip(box: Rect, target: { x: number; y: number }, panel: Rect, fontSize: number) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;
  const edge = Math.min(Math.abs(dx) > 1e-6 ? box.w / 2 / Math.abs(dx / dist) : Infinity, Math.abs(dy) > 1e-6 ? box.h / 2 / Math.abs(dy / dist) : Infinity);
  const maxLen = Math.max(fontSize * 1.6, Math.min(Math.hypot(panel.w, panel.h) * 0.22, fontSize * 5));
  const len = Math.min(dist - fontSize * 0.8, edge + maxLen);
  if (len <= edge + fontSize * 0.6) {
    // The speaker is right under the balloon: a short stub towards them.
    const l = edge + fontSize * 1.2;
    return clampPoint({ x: cx + (dx / dist) * l, y: cy + (dy / dist) * l }, panel);
  }
  return clampPoint({ x: cx + (dx / dist) * len, y: cy + (dy / dist) * len }, panel);
}

const clampPoint = (p: { x: number; y: number }, r: Rect) => ({ x: Math.round(Math.min(r.x + r.w - 4, Math.max(r.x + 4, p.x))), y: Math.round(Math.min(r.y + r.h - 4, Math.max(r.y + 4, p.y))) });

type Candidate = { rect: Rect; row: number; col: number };

/** Nine anchor positions inside the panel (3 rows × 3 columns), each clamped to the panel's inner area. */
function candidates(inner: Rect, w: number, h: number): Candidate[] {
  const out: Candidate[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = col === 0 ? inner.x : col === 1 ? inner.x + (inner.w - w) / 2 : inner.x + inner.w - w;
      const y = row === 0 ? inner.y : row === 1 ? inner.y + (inner.h - h) / 2 : inner.y + inner.h - h;
      out.push({ rect: { x: Math.round(x), y: Math.round(y), w, h }, row, col });
    }
  }
  return out;
}

/**
 * Places every automatic balloon of a panel. Reading order is the balloons' order; earlier ones prefer the start of
 * the reading direction and the top of the panel. A balloon that cannot avoid overlaps shrinks down to
 * `MIN_FONT_SCALE`; one that still does not fit inside the panel is clamped and flagged `overflow`.
 */
export function letterPanel(panel: Panel, opts: { pageWidth: number; font: ComicFont; direction: ReadingDirection }): Panel {
  const { border } = pageGeometry({ width: opts.pageWidth });
  const pad = border + Math.round(baseFontSize(opts.pageWidth) * 0.35);
  const inner: Rect = { x: panel.rect.x + pad, y: panel.rect.y + pad, w: panel.rect.w - 2 * pad, h: panel.rect.h - 2 * pad };
  const faces = facesOnPage(panel).map((f) => grow(f, f.w * 0.15));
  const placed: Rect[] = panel.lettering.filter((b) => b.manual && b.rect).map((b) => b.rect!);
  /** Tails already drawn (centre of the balloon → tip): a later balloon must not sit on one, nor send its own through a balloon. */
  const tails: { a: { x: number; y: number }; b: { x: number; y: number } }[] = panel.lettering.filter((b) => b.manual && b.rect && b.tail).map((b) => ({ a: centre(b.rect!), b: b.tail! }));
  const startCol = opts.direction === "rtl" ? 2 : 0;
  let order = 0;

  const lettering = panel.lettering.map((b): Balloon => {
    if (b.manual) return b;
    if (!b.text.trim()) return { ...b, rect: null, tail: null };
    const base = fontSizeFor(b.kind, opts.pageWidth);
    const maxW = b.kind === "caption" ? inner.w : Math.min(inner.w * (b.kind === "sfx" ? 0.8 : 0.66), opts.pageWidth * 0.42);
    const target = b.kind === "caption" || b.kind === "sfx" ? null : speakerPoint(panel, b.speaker);
    let best: { rect: Rect; cost: number; fontSize: number } | null = null;
    for (let scale = 1; scale >= MIN_FONT_SCALE - 1e-9; scale -= 0.07) {
      const fontSize = Math.round(base * scale);
      const box = balloonBox(b.text, b.kind, fontSize, maxW, opts.font);
      const w = Math.min(box.w, inner.w);
      const h = Math.min(box.h, inner.h);
      for (const c of candidates(inner, w, h)) {
        const a = area(c.rect) || 1;
        const faceHit = faces.reduce((s, f) => s + overlap(c.rect, f), 0) / a;
        const balloonHit = placed.reduce((s, p) => s + overlap(c.rect, grow(p, fontSize * 0.3)), 0) / a;
        let cost = (b.kind === "sfx" ? 300 : 1000) * faceHit + 800 * balloonHit;
        if (tails.some((t) => segmentHits(t.a, t.b, grow(c.rect, fontSize * 0.2)))) cost += 60;
        if (target && placed.some((p) => segmentHits(centre(c.rect), target, p))) cost += 60;
        if (b.kind === "sfx") cost += Math.abs(c.row - 1) * 2 + Math.abs(c.col - 1);
        else {
          cost += c.row * 3; // top band first
          cost += Math.abs(c.col - (order === 0 ? startCol : 1)) * 1.2 + (order > 0 && c.col === startCol && c.row === 0 ? 2 : 0);
          if (target) {
            const side = target.x < panel.rect.x + panel.rect.w / 3 ? 0 : target.x > panel.rect.x + (2 * panel.rect.w) / 3 ? 2 : 1;
            cost += Math.abs(c.col - side) * 1.5;
          }
        }
        if (b.kind === "caption") cost += (c.col === startCol ? 0 : 6) + (c.row === 1 ? 10 : 0);
        const excess = Math.max(0, box.w / inner.w - 1) + Math.max(0, box.h / inner.h - 1);
        if (excess > 0) cost += 500 + 300 * excess;
        // A smaller font is only worth it when it removes an overlap.
        cost += (1 - scale) * 40;
        if (!best || cost < best.cost) best = { rect: c.rect, cost, fontSize };
      }
      if (best && best.cost < 40) break;
    }
    const chosen = best!;
    placed.push(chosen.rect);
    order++;
    const fits = balloonBox(b.text, b.kind, chosen.fontSize, maxW, opts.font);
    const overflow = fits.w > inner.w || fits.h > inner.h;
    const tip = target ? tailTip(chosen.rect, target, panel.rect, chosen.fontSize) : null;
    if (tip) tails.push({ a: centre(chosen.rect), b: tip });
    const placedBalloon: Balloon = {
      ...b,
      rect: chosen.rect,
      fontSize: chosen.fontSize,
      tail: tip,
    };
    delete placedBalloon.overflow;
    return overflow ? { ...placedBalloon, overflow: true } : placedBalloon;
  });
  return { ...panel, lettering };
}
