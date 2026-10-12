import { pageGeometry, type ComicFormat, type PageLayout, type PanelSize, type ReadingDirection, type Rect } from "@ai-news/video/comic";

/**
 * Page formats and the panel layout engine (docs/COMIC.md §3, §13.5). Pure and tested: the rectangles it returns
 * are the panels' frames on the page, and the aspect ratio the image model is asked for comes from them.
 */

export type PageFormatDef = ComicFormat & { label: string; note: string };

/** Pixel sizes are the export resolution (≈ 150 dpi for the print-like sizes). */
export const PAGE_FORMATS: readonly PageFormatDef[] = [
  { id: "a4", label: "A4 dọc", note: "1240 × 1754", width: 1240, height: 1754, scroll: false },
  { id: "us_comic", label: "Truyện tranh Mỹ", note: "6.625 × 10.25 in", width: 1200, height: 1857, scroll: false },
  { id: "manga_b6", label: "Manga B6", note: "128 × 182 mm", width: 1200, height: 1706, scroll: false },
  { id: "webtoon", label: "Webtoon (cuộn dọc)", note: "rộng 800, cuộn dọc", width: 800, height: 0, scroll: true },
  { id: "square", label: "Vuông 1:1", note: "1440 × 1440, đăng dạng carousel", width: 1440, height: 1440, scroll: false },
  { id: "story", label: "9:16", note: "1080 × 1920, stories", width: 1080, height: 1920, scroll: false },
];
export const DEFAULT_FORMAT = "a4";

export const pageFormat = (id: string | null | undefined): PageFormatDef => PAGE_FORMATS.find((f) => f.id === id) ?? PAGE_FORMATS[0];
export const formatOf = (id: string | null | undefined): ComicFormat => {
  const f = pageFormat(id);
  return { id: f.id, width: f.width, height: f.height, scroll: f.scroll };
};

/** How tall a row is, relative to the others on the page. */
const ROW_WEIGHT: Record<PanelSize, number> = { small: 1, medium: 1.2, wide: 1.1, large: 1.8, tall: 1.6 };
/** How wide a panel is, relative to its neighbours in a row. */
const COL_WEIGHT: Record<PanelSize, number> = { small: 1, medium: 1.3, wide: 1.3, large: 1.3, tall: 0.9 };
/** Webtoon: panel height as a share of the column width. */
const SCROLL_RATIO: Record<PanelSize, number> = { small: 0.75, medium: 1, wide: 0.56, large: 1.25, tall: 1.5 };

type Row = { sizes: PanelSize[]; idx: number[] };

/** Groups a page's panels into rows: wide and large panels get a row of their own, small ones go three to a row. */
export function rowsFor(sizes: PanelSize[], hint: PageLayout): Row[] {
  if (hint === "splash" || sizes.length === 1) return sizes.map((s, i) => ({ sizes: [s], idx: [i] }));
  const rows: Row[] = [];
  let cur: Row = { sizes: [], idx: [] };
  const flush = () => {
    if (cur.idx.length) rows.push(cur);
    cur = { sizes: [], idx: [] };
  };
  sizes.forEach((s, i) => {
    const alone = hint !== "grid" && (s === "wide" || s === "large" || (hint === "wide-top" && i === 0));
    if (alone) {
      flush();
      rows.push({ sizes: [s], idx: [i] });
      return;
    }
    cur.sizes.push(s);
    cur.idx.push(i);
    const cap = hint === "grid" ? 2 : cur.sizes.every((x) => x === "small") ? 3 : 2;
    if (cur.sizes.length >= cap) flush();
  });
  flush();
  return rows;
}

const split = (total: number, weights: number[], gap: number) => {
  const free = total - gap * (weights.length - 1);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return weights.map((w, i) => {
    const size = i === weights.length - 1 ? total - at : Math.round((free * w) / sum);
    const out = { at, size };
    at += size + gap;
    return out;
  });
};

const mirror = (r: Rect, width: number): Rect => ({ ...r, x: width - r.x - r.w });

/**
 * Panel rectangles for one page. Fixed formats fill the page between the margins; the webtoon format stacks the
 * panels in one column and the page is as tall as they need. Right-to-left mirrors the page (manga).
 */
export function layoutPage(format: ComicFormat, sizes: PanelSize[], hint: PageLayout, dir: ReadingDirection): { height: number; rects: Rect[] } {
  const { margin, gutter } = pageGeometry(format);
  const W = format.width - 2 * margin;
  if (!sizes.length) return { height: format.scroll ? 2 * margin : format.height, rects: [] };

  if (format.scroll) {
    const gap = Math.round(format.width * 0.06);
    let y = margin;
    const rects = sizes.map((s) => {
      const h = Math.round(W * SCROLL_RATIO[s]);
      const r = { x: margin, y, w: W, h };
      y += h + gap;
      return r;
    });
    return { height: y - gap + margin, rects };
  }

  const H = format.height - 2 * margin;
  let rects: Rect[] = new Array(sizes.length);

  if (hint === "tall-left" && sizes.length >= 2) {
    const [left, right] = split(W, [0.42, 0.58], gutter);
    rects[0] = { x: margin + left.at, y: margin, w: left.size, h: H };
    split(H, sizes.slice(1).map((s) => ROW_WEIGHT[s]), gutter).forEach((p, j) => {
      rects[j + 1] = { x: margin + right.at, y: margin + p.at, w: right.size, h: p.size };
    });
  } else {
    const rows = rowsFor(sizes, hint);
    const ys = split(H, rows.map((r) => Math.max(...r.sizes.map((s) => ROW_WEIGHT[s]))), gutter);
    rows.forEach((row, ri) => {
      const xs = split(W, row.sizes.map((s) => COL_WEIGHT[s]), gutter);
      row.idx.forEach((pi, k) => {
        rects[pi] = { x: margin + xs[k].at, y: margin + ys[ri].at, w: xs[k].size, h: ys[ri].size };
      });
    });
  }
  if (dir === "rtl") rects = rects.map((r) => mirror(r, format.width));
  return { height: format.height, rects };
}

/** The supported aspect ratio ("3:4") closest to a panel's shape, compared on a log scale. */
export function snapAspect(w: number, h: number, ratios: readonly string[]): string {
  const target = Math.log(w / h);
  let best = ratios[0];
  let bestD = Infinity;
  for (const r of ratios) {
    const [a, b] = r.split(":").map(Number);
    const d = Math.abs(Math.log(a / b) - target);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}
