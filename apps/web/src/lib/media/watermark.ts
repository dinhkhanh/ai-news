/**
 * Watermark detection for downloaded clips (originality, `originality.ts`). Meta's creator guidance asks Pages to
 * avoid "visible third-party watermarks and content that is visibly recycled from other apps or sources": a clip
 * carrying TikTok's moving logo, an @handle or a broadcaster's corner bug reads as a re-upload however it is edited.
 *
 * `watermark-scan.ts` grabs a few frames of the clip (media Lambda `cover`) and reads them with Cloud Vision
 * (`TEXT_DETECTION` + `LOGO_DETECTION`); this pure module turns those readings into a verdict:
 * - `platform`: any frame shows a short-video app's name or an @handle (their watermarks move around the frame);
 * - `logo`: the same logo at the same place near the edge of the frame in at least two frames (a station bug);
 * - `text`: the same word at the same place near the edge in at least two frames (a text bug, a channel name,
 *   a branded lower third).
 * Text and logos inside the picture move or change between frames, overlays do not. A graphic-only bug Vision
 * cannot name is not caught. Shared by the build, the editor's actions and checks, and the tests.
 */

/** A box normalised to the frame (0–1, origin top-left). */
export type MarkBox = { x: number; y: number; w: number; h: number };
/** What Vision read in one frame: words (not the full-text block) and logos. */
export type FrameMarks = { texts: Array<{ text: string; box: MarkBox }>; logos: Array<{ name: string; box: MarkBox }> };

export type WatermarkMark = { kind: "platform" | "logo" | "text"; label: string; box: MarkBox };
/** Stored in `assets.meta.watermark` so a clip is only scanned once. */
export type WatermarkVerdict = { watermarked: boolean; marks: WatermarkMark[]; frames: number };

/** Short-video and social apps whose exports carry their name as a watermark. */
const PLATFORM_WORDS = /^(tiktok|douyin|抖音|capcut|kuaishou|快手|kwai|likee|snapchat|instagram|reels|bilibili|小红书|xiaohongshu|lemon8|triller|youtube)$/i;
/** An account handle: how TikTok, Reels and Shorts exports sign the clip. */
const HANDLE = /^@[\p{L}\p{N}._]{2,}$/u;

/** A box whose centre lies in the outer band of the frame, where overlays sit. */
export function nearEdge(b: MarkBox, band = { x: 0.2, y: 0.15 }) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return cx < band.x || cx > 1 - band.x || cy < band.y || cy > 1 - band.y;
}

/** Intersection over union of two boxes. */
export function iou(a: MarkBox, b: MarkBox) {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase().replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * Items (text or logos) found at the same place, under the same name, near the edge in at least `minFrames` frames.
 * Returns one representative per persistent item.
 */
function persistent<T extends { box: MarkBox }>(frames: T[][], label: (t: T) => string, minFrames: number): T[] {
  const out: T[] = [];
  frames.forEach((items, f) => {
    for (const it of items) {
      const name = label(it);
      if (name.length < 2 || !nearEdge(it.box)) continue;
      if (out.some((o) => label(o) === name && iou(o.box, it.box) >= 0.5)) continue;
      const seen = 1 + frames.filter((other, g) => g !== f && other.some((o) => label(o) === name && iou(o.box, it.box) >= 0.5)).length;
      if (seen >= minFrames) out.push(it);
    }
  });
  return out;
}

/** The verdict for one clip from the frames Vision read (any number; persistence needs at least two). */
export function detectWatermark(frames: FrameMarks[]): WatermarkVerdict {
  const marks: WatermarkMark[] = [];
  const seen = new Set<string>();
  const add = (m: WatermarkMark) => {
    const k = `${m.kind}:${m.label.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    marks.push(m);
  };
  for (const f of frames)
    for (const t of f.texts) {
      const w = norm(t.text);
      if (PLATFORM_WORDS.test(w) || HANDLE.test(t.text.trim())) add({ kind: "platform", label: t.text.trim(), box: t.box });
    }
  if (frames.length >= 2) {
    for (const l of persistent(frames.map((f) => f.logos), (l) => norm(l.name), 2)) add({ kind: "logo", label: l.name, box: l.box });
    for (const t of persistent(frames.map((f) => f.texts), (t) => norm(t.text), 2)) add({ kind: "text", label: t.text.trim(), box: t.box });
  }
  return { watermarked: marks.length > 0, marks: marks.slice(0, 8), frames: frames.length };
}

/** When to grab frames from a clip of `durationSec`: early, middle and late, clear of the cut points. */
export function sampleTimes(durationSec: number | null, count = 3): number[] {
  const d = durationSec && durationSec > 0 ? durationSec : 5;
  if (d < 1.5) return [Math.round((d / 2) * 100) / 100];
  return Array.from({ length: count }, (_, i) => Math.round(d * (0.15 + (0.7 * i) / Math.max(1, count - 1)) * 100) / 100);
}

/** Short description of a verdict's marks for the editor ("TikTok, @user, VTV"). */
export function watermarkLabel(v: { marks: Array<Pick<WatermarkMark, "label">> }, max = 3) {
  const labels = [...new Set(v.marks.map((m) => m.label))];
  return labels.slice(0, max).join(", ") + (labels.length > max ? "…" : "");
}

/** `assets.meta.watermark` if this clip was scanned before. */
export function storedWatermark(meta: unknown): WatermarkVerdict | null {
  const w = (meta as { watermark?: WatermarkVerdict } | null)?.watermark;
  return w && typeof w.watermarked === "boolean" && Array.isArray(w.marks) && typeof w.frames === "number" ? w : null;
}
