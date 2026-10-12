import { z } from "zod";

/**
 * Comic document (docs/COMIC.md §7): the single source the reader, the editor and the page export draw from.
 * Stored in `comic_versions.doc`; image references are R2 keys, never URLs (resolved right before a render or a view).
 * Coordinates are page pixels of the comic's format (`format.width` × `format.height`).
 */

export const COMIC_DOC_VERSION = 1;

export const READING_DIRECTIONS = ["ltr", "rtl"] as const;
export type ReadingDirection = (typeof READING_DIRECTIONS)[number];

export const PANEL_SIZES = ["small", "medium", "large", "wide", "tall"] as const;
export type PanelSize = (typeof PANEL_SIZES)[number];

export const SHOTS = ["establishing", "wide", "medium", "close-up", "extreme close-up", "over-the-shoulder", "bird's-eye", "worm's-eye"] as const;
export type Shot = (typeof SHOTS)[number];

export const CHARACTER_POSITIONS = ["left", "center", "right", "background"] as const;
export type CharacterPosition = (typeof CHARACTER_POSITIONS)[number];

export const LETTERING_KINDS = ["speech", "thought", "shout", "whisper", "caption", "sfx"] as const;
export type LetteringKind = (typeof LETTERING_KINDS)[number];

export const PAGE_LAYOUTS = ["auto", "grid", "splash", "wide-top", "tall-left"] as const;
export type PageLayout = (typeof PAGE_LAYOUTS)[number];

/** Lettering faces with full Vietnamese coverage (Google Fonts); the composition loads them with @remotion/google-fonts. */
export const COMIC_FONTS = {
  itim: { family: "Itim", label: "Itim (viết tay)" },
  bevietnam: { family: "Be Vietnam Pro", label: "Be Vietnam Pro" },
} as const;
export type ComicFont = keyof typeof COMIC_FONTS;

const rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Rect = z.infer<typeof rect>;

export const balloonSchema = z.object({
  id: z.string(),
  kind: z.enum(LETTERING_KINDS),
  /** Cast `ref` of the speaker; null for captions and sound effects. */
  speaker: z.string().nullable(),
  text: z.string(),
  /** Page px; null until the lettering pass has placed it. */
  rect: rect.nullable(),
  /** Where the tail points (page px); null = no tail (captions, sfx). */
  tail: z.object({ x: z.number(), y: z.number() }).nullable(),
  fontSize: z.number(),
  /** Moved by hand: never re-placed automatically. */
  manual: z.boolean(),
  /** The text did not fit even at the smallest size: the editor flags it. */
  overflow: z.boolean().optional(),
});
export type Balloon = z.infer<typeof balloonSchema>;

export const panelCharacterSchema = z.object({
  ref: z.string(),
  position: z.enum(CHARACTER_POSITIONS),
  action: z.string(),
  expression: z.string(),
});

export const panelScriptSchema = z.object({
  size: z.enum(PANEL_SIZES),
  shot: z.enum(SHOTS),
  settingId: z.string().nullable(),
  time: z.string(),
  mood: z.string(),
  characters: z.array(panelCharacterSchema),
  /** English: what the picture shows (never any text in it). */
  description: z.string(),
});
export type PanelScript = z.infer<typeof panelScriptSchema>;

export const panelImageSchema = z.object({
  /** comic_images.id */
  id: z.string(),
  key: z.string(),
  width: z.number(),
  height: z.number(),
  /** Faces found in the picture, normalised 0..1 (Cloud Vision), used to keep balloons off them. */
  faces: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).optional(),
});
export type PanelImage = z.infer<typeof panelImageSchema>;

/**
 * Framing of the picture inside its panel: the picture covers the frame (as CSS `object-fit: cover`), `x` / `y`
 * (0..1) say which part stays in view when it is cropped, and `zoom` (≥ 1) enlarges it around that point.
 */
export const panelCropSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), zoom: z.number().min(1).max(4) });
export type PanelCrop = z.infer<typeof panelCropSchema>;
export const DEFAULT_CROP: PanelCrop = { x: 0.5, y: 0.5, zoom: 1 };

export const panelSchema = z.object({
  id: z.string(),
  rect,
  script: panelScriptSchema,
  /** The picture shown; one of `variants`. */
  image: panelImageSchema.nullable(),
  variants: z.array(panelImageSchema),
  /** Absent = centred, no zoom. */
  crop: panelCropSchema.optional(),
  /** Last drawing error, cleared by the next successful drawing. */
  error: z.string().nullable(),
  lettering: z.array(balloonSchema),
});
export type Panel = z.infer<typeof panelSchema>;

export const pageSchema = z.object({
  id: z.string(),
  beat: z.string(),
  layout: z.enum(PAGE_LAYOUTS),
  /** Webtoon pages grow with their panels; other formats keep `format.height`. */
  height: z.number(),
  panels: z.array(panelSchema),
});
export type ComicPage = z.infer<typeof pageSchema>;

export const castMemberSchema = z.object({
  /** Stable id inside the comic: a `comic_characters.id`, or `new:<slug>` for a character the adaptation proposed. */
  ref: z.string(),
  characterId: z.string().nullable(),
  name: z.string(),
  role: z.string(),
  /** English, for the image prompts. */
  visual: z.string(),
  personality: z.string(),
});
export type CastMember = z.infer<typeof castMemberSchema>;

export const settingSchema = z.object({ id: z.string(), name: z.string(), visual: z.string() });
export type Setting = z.infer<typeof settingSchema>;

export const comicFormatSchema = z.object({
  id: z.string(),
  width: z.number(),
  height: z.number(),
  /** Webtoon: one long column, pages grow downwards. */
  scroll: z.boolean(),
});
export type ComicFormat = z.infer<typeof comicFormatSchema>;

export const comicDocSchema = z.object({
  v: z.literal(COMIC_DOC_VERSION),
  title: z.string(),
  logline: z.string(),
  language: z.enum(["vi", "en"]),
  readingDirection: z.enum(READING_DIRECTIONS),
  format: comicFormatSchema,
  font: z.enum(Object.keys(COMIC_FONTS) as [ComicFont, ...ComicFont[]]),
  /** "Minh hoạ bởi AI (Gemini)" on the last page; null = off. */
  credit: z.string().nullable(),
  cast: z.array(castMemberSchema),
  settings: z.array(settingSchema),
  pages: z.array(pageSchema),
});
export type ComicDoc = z.infer<typeof comicDocSchema>;

/** Gutter / margin geometry shared by the layout engine and the page renderer. */
export function pageGeometry(format: { width: number }) {
  const margin = Math.round(format.width * 0.04);
  const gutter = Math.round(format.width * 0.018);
  const border = Math.max(3, Math.round(format.width * 0.004));
  return { margin, gutter, border };
}

/**
 * Where a point of the picture (normalised 0..1) lands on the page, for a picture drawn into `frame` with `crop`.
 * Mirrors the renderer: cover fit, `object-position` = crop x/y, then `scale(zoom)` around that same point.
 */
export function pictureToPage(frame: Rect, img: { width: number; height: number }, crop: PanelCrop | undefined, p: { x: number; y: number }) {
  const c = crop ?? DEFAULT_CROP;
  const s = Math.max(frame.w / img.width, frame.h / img.height);
  const ox = (img.width * s - frame.w) * c.x;
  const oy = (img.height * s - frame.h) * c.y;
  const lx = p.x * img.width * s - ox;
  const ly = p.y * img.height * s - oy;
  const cx = frame.w * c.x;
  const cy = frame.h * c.y;
  return { x: frame.x + cx + (lx - cx) * c.zoom, y: frame.y + cy + (ly - cy) * c.zoom };
}

/** Line height of balloon text, as a multiple of the font size. */
export const BALLOON_LINE_HEIGHT = 1.2;
/** Inner padding of a balloon, as a multiple of the font size. */
export const BALLOON_PADDING = 0.7;

/** Webtoon export (docs/COMIC.md §2.7): one column this wide, cut into files no taller than this. */
export const STRIP_WIDTH = 800;
export const STRIP_MAX_HEIGHT = 8000;

/** A slice of a page drawn into a strip file: `src*` in page px, `dst*` in px of the file. */
export type StripPiece = { page: number; srcTop: number; srcHeight: number; dstTop: number; dstHeight: number };
export type StripPart = { height: number; pieces: StripPiece[] };

/**
 * Plans the webtoon strip: every page scaled to `width`, stacked with a white gap between pages (none for the
 * webtoon format, whose pages already run on), cut into parts of at most `maxHeight`. Cuts fall where no panel,
 * balloon or tail is (between pages, or in a gutter), as low as possible; only a single panel taller than a part
 * is cut through.
 */
export function planStrip(doc: Pick<ComicDoc, "format" | "pages">, opts: { width?: number; maxHeight?: number } = {}): StripPart[] {
  const width = opts.width ?? STRIP_WIDTH;
  const maxHeight = opts.maxHeight ?? STRIP_MAX_HEIGHT;
  if (!doc.pages.length) return [];
  const s = width / doc.format.width;
  const gap = doc.format.scroll ? 0 : Math.round(width * 0.05);
  const pad = pageGeometry(doc.format).border * 2;
  const tops: number[] = [];
  const heights: number[] = [];
  const busy: [number, number][] = [];
  let y = 0;
  doc.pages.forEach((page, i) => {
    if (i) y += gap;
    const h = Math.round(page.height * s);
    tops.push(y);
    heights.push(h);
    // What must not be cut through (page px), padded for borders and strokes, mapped to strip px.
    const ranges: [number, number][] = [];
    for (const panel of page.panels) {
      ranges.push([panel.rect.y, panel.rect.y + panel.rect.h]);
      for (const b of panel.lettering) {
        if (!b.rect) continue;
        const ys = [b.rect.y, b.rect.y + b.rect.h, ...(b.tail ? [b.tail.y] : [])];
        ranges.push([Math.min(...ys), Math.max(...ys)]);
      }
    }
    for (const [a, b] of ranges) busy.push([y + Math.max(0, (a - pad) * s), y + Math.min(h, (b + pad) * s)]);
    y += h;
  });
  const total = y;
  busy.sort((a, b) => a[0] - b[0]);
  // Free ranges = the complement of the merged busy ranges.
  const free: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of busy) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < total) free.push([cursor, total]);

  const cuts: number[] = [];
  let start = 0;
  const minPart = maxHeight / 4;
  while (total - start > maxHeight) {
    const limit = start + maxHeight;
    let best = -1;
    for (const [a, b] of free) {
      if (a > limit) break;
      const c = b <= limit ? (a + b) / 2 : limit;
      if (c > start + minPart && c > best) best = c;
    }
    const cut = Math.round(best > 0 ? best : limit);
    cuts.push(cut);
    start = cut;
  }
  const bounds = [0, ...cuts, total];
  const parts: StripPart[] = [];
  for (let p = 0; p < bounds.length - 1; p++) {
    const [from, to] = [bounds[p], bounds[p + 1]];
    const pieces: StripPiece[] = [];
    doc.pages.forEach((_, i) => {
      const a = Math.max(from, tops[i]);
      const b = Math.min(to, tops[i] + heights[i]);
      if (b - a < 1) return;
      pieces.push({ page: i, srcTop: (a - tops[i]) / s, srcHeight: (b - a) / s, dstTop: a - from, dstHeight: b - a });
    });
    parts.push({ height: to - from, pieces });
  }
  return parts;
}
