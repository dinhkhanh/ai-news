import { z } from "zod";
import { balloonSchema, COMIC_FONTS, panelCropSchema, pictureToPage, READING_DIRECTIONS, type ComicFont, type Rect } from "./comic";

/**
 * Motion comic as a cartoon (composition 0.21.0, docs/COMIC.md §11.6). A timeline made from a comic carries the
 * panels it shows (`timeline.cartoon`) and, per scene, which panel, which balloon is being read and whose face
 * (`scenes[].cartoon`). `News` then hands the whole video to `Cartoon.tsx`: each panel drawn whole with its own
 * balloons, a balloon popping in when its line starts and staying for the rest of the panel, a camera gliding from
 * speaker to speaker inside the panel, a comic transition between panels, a title card and an end card. No headline
 * card, captions, credit lines, outro or brand overlay. Coordinates are comic page px, relative to the panel's
 * top-left corner. Pure, no React (tested from the web app).
 */

const box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const cartoonPanelSchema = z.object({
  /** 1-based page of the comic: a new page turns, the next panel of the same page slides in. */
  page: z.number().int().nonnegative(),
  /** Size of the panel frame (comic page px). */
  w: z.number().positive(),
  h: z.number().positive(),
  /** R2 key of the picture in storage, a URL at render time. */
  src: z.string(),
  imgW: z.number().positive(),
  imgH: z.number().positive(),
  crop: panelCropSchema.nullable().default(null),
  /** The panel's lettering, rects and tails relative to the panel's top-left corner. */
  balloons: z.array(balloonSchema).default([]),
});
export type CartoonPanel = z.infer<typeof cartoonPanelSchema>;

const fonts = Object.keys(COMIC_FONTS) as [ComicFont, ...ComicFont[]];

export const cartoonSchema = z.object({
  font: z.enum(fonts),
  readingDirection: z.enum(READING_DIRECTIONS).default("ltr"),
  panels: z.record(z.string(), cartoonPanelSchema),
});
export type Cartoon = z.infer<typeof cartoonSchema>;

export const cartoonSceneSchema = z.object({
  /** Key into `cartoon.panels`. */
  panel: z.string(),
  /** The balloon this scene reads; null = a silent beat, a sound effect or the closing card. */
  balloon: z.string().nullable().default(null),
  /** The speaker's face in the picture (normalised 0..1); null = frame the whole panel. */
  face: box.nullable().default(null),
});
export type CartoonScene = z.infer<typeof cartoonSceneSchema>;

/** Where panels are drawn on the 1080×1920 frame: clear of the logo above and the platforms' buttons below. */
export const CARTOON_VIEW = { x: 40, y: 210, w: 1000, h: 1370 } as const;
/** Furthest the camera moves in on a speaker. */
export const CARTOON_MAX_ZOOM = 1.7;
/** Frames the camera takes to glide to the next speaker. */
export const CARTOON_MOVE_FRAMES = 16;
/** Slow push-in over each beat, as a share of the zoom. */
export const CARTOON_DRIFT = 0.03;
/** Frames the next panel takes to come in over the previous one. */
export const CARTOON_TRANSITION_FRAMES = 12;
/** Frames a balloon takes to pop in. */
export const CARTOON_POP_FRAMES = 8;

/**
 * What the camera looks at: a point of the stage (panel px) put at the centre of the view, and the zoom over the
 * base fit; `panTo` = where the centre travels to while the beat lasts (a wide or tall panel read across).
 */
export type Camera = { cx: number; cy: number; zoom: number; panTo?: { cx: number; cy: number } };

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The area drawn for a panel: its frame plus every balloon and tail that sticks out of it, with a small margin. */
export function stageBounds(panel: Pick<CartoonPanel, "w" | "h" | "balloons">): Rect {
  let r: Rect = { x: 0, y: 0, w: panel.w, h: panel.h };
  for (const b of panel.balloons) {
    if (!b.rect || !b.text.trim()) continue;
    r = union(r, b.rect);
    if (b.tail) r = union(r, { x: b.tail.x, y: b.tail.y, w: 0, h: 0 });
  }
  const pad = Math.round(Math.max(panel.w, panel.h) * 0.02);
  return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
}

/** Screen px per stage px when the whole stage fits the view. */
export function baseScale(stage: Rect, view: Rect = CARTOON_VIEW) {
  return Math.min(view.w / stage.w, view.h / stage.h);
}

/** A face (normalised to the picture) in panel px, through the panel's crop. */
export function faceInPanel(panel: Pick<CartoonPanel, "w" | "h" | "imgW" | "imgH" | "crop">, face: Rect): Rect {
  const frame = { x: 0, y: 0, w: panel.w, h: panel.h };
  const img = { width: panel.imgW, height: panel.imgH };
  const crop = panel.crop ?? undefined;
  const a = pictureToPage(frame, img, crop, { x: face.x, y: face.y });
  const b = pictureToPage(frame, img, crop, { x: face.x + face.w, y: face.y + face.h });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

/** The whole panel, centred. */
export const wideCamera = (stage: Rect): Camera => ({ cx: stage.x + stage.w / 2, cy: stage.y + stage.h / 2, zoom: 1 });

/**
 * The panel as a whole: centred when it fits the view well; a wide panel (it would sit as a thin band across the
 * frame) is enlarged to fill about 60 % of the view's height and read across in the reading direction, a tall one
 * enlarged to the view's width and read downwards. `direction` -1 = right to left.
 */
export function overviewCamera(stage: Rect, direction: 1 | -1 = 1, view: Rect = CARTOON_VIEW): Camera {
  const base = baseScale(stage, view);
  const sw = stage.w * base;
  const sh = stage.h * base;
  const mid = wideCamera(stage);
  if (sh < view.h * 0.6) {
    const zoom = Math.min(CARTOON_MAX_ZOOM, (view.h * 0.6) / sh);
    const half = view.w / (2 * base * zoom);
    if (zoom < 1.05 || half * 2 >= stage.w) return mid;
    const [a, b] = [stage.x + half, stage.x + stage.w - half];
    return { cx: direction === 1 ? a : b, cy: mid.cy, zoom, panTo: { cx: direction === 1 ? b : a, cy: mid.cy } };
  }
  if (sw < view.w * 0.75) {
    const zoom = Math.min(CARTOON_MAX_ZOOM, view.w / sw);
    const half = view.h / (2 * base * zoom);
    if (zoom < 1.05 || half * 2 >= stage.h) return mid;
    return { cx: mid.cx, cy: stage.y + half, zoom, panTo: { cx: mid.cx, cy: stage.y + stage.h - half } };
  }
  return mid;
}

/**
 * Where the camera goes for a beat: the balloon being read together with the speaker's face, as close as fits
 * (≤ `CARTOON_MAX_ZOOM`); the face alone for a silent beat on someone; the whole panel otherwise (narration,
 * sound effects, the end card). The centre is held inside the stage so the view never runs off the panel.
 */
export function beatCamera(panel: CartoonPanel, scene: Pick<CartoonScene, "balloon" | "face"> | null, direction: 1 | -1 = 1, view: Rect = CARTOON_VIEW): Camera {
  const stage = stageBounds(panel);
  const base = baseScale(stage, view);
  const balloon = scene?.balloon ? panel.balloons.find((b) => b.id === scene.balloon && b.rect) : undefined;
  // Captions are read by the narrator over the whole picture: no reason to move in.
  const face = scene?.face && balloon?.kind !== "caption" ? faceInPanel(panel, scene.face) : null;
  let target: Rect | null = null;
  if (balloon?.rect && balloon.kind !== "caption") target = face ? union(balloon.rect, face) : balloon.rect;
  else if (face && !balloon) target = { x: face.x - face.w, y: face.y - face.h * 0.6, w: face.w * 3, h: face.h * 2.6 };
  if (!target) {
    const cam = overviewCamera(stage, direction, view);
    return balloon?.rect ? keepInView(cam, balloon.rect, base, view) : cam;
  }
  const margin = 1.3;
  const zoom = Math.max(1, Math.min(CARTOON_MAX_ZOOM, view.w / (target.w * margin * base), view.h / (target.h * margin * base)));
  const axis = (size: number, start: number, length: number, centre: number) => {
    if (length * base * zoom <= size) return start + length / 2;
    const half = size / (2 * base * zoom);
    return Math.min(Math.max(centre, start + half), start + length - half);
  };
  return { cx: axis(view.w, stage.x, stage.w, target.x + target.w / 2), cy: axis(view.h, stage.y, stage.h, target.y + target.h / 2), zoom };
}

/**
 * A panning camera that keeps `r` (the caption being read) whole in the view: the pan stops where the box would
 * start to leave it; a box wider than the view keeps the camera on it.
 */
export function keepInView(cam: Camera, r: Rect, base: number, view: Rect = CARTOON_VIEW): Camera {
  if (!cam.panTo) return cam;
  const hw = view.w / (2 * base * cam.zoom);
  const hh = view.h / (2 * base * cam.zoom);
  const fit = (v: number, lo: number, hi: number, centre: number) => (lo > hi ? centre : Math.min(Math.max(v, lo), hi));
  const x = (v: number) => fit(v, r.x + r.w - hw, r.x + hw, r.x + r.w / 2);
  const y = (v: number) => fit(v, r.y + r.h - hh, r.y + hh, r.y + r.h / 2);
  return { ...cam, cx: x(cam.cx), cy: y(cam.cy), panTo: { cx: x(cam.panTo.cx), cy: y(cam.panTo.cy) } };
}

/** One panel on screen for consecutive scenes ("run"): frames relative to the run's start. */
export type RunBeat = { from: number; durationFrames: number; camera: Camera };

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The camera at `frame` of a run: it opens on `opening` (the panel as a whole), glides to each beat's camera over
 * `CARTOON_MOVE_FRAMES` from where the previous beat left it, follows the beat's pan, and pushes in slowly while
 * a beat lasts.
 */
export function cameraAt(beats: RunBeat[], opening: Camera, frame: number): Camera {
  if (!beats.length) return opening;
  let i = 0;
  for (let k = 0; k < beats.length; k++) if (frame >= beats[k].from) i = k;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  /** A beat's camera `p` (0..1) of the way through it: along its pan, pushed in by the drift. */
  const along = (c: Camera, p: number) => {
    const q = easeInOut(clamp01(p));
    return { cx: c.panTo ? lerp(c.cx, c.panTo.cx, q) : c.cx, cy: c.panTo ? lerp(c.cy, c.panTo.cy, q) : c.cy, zoom: c.zoom * (1 + CARTOON_DRIFT * clamp01(p)) };
  };
  const prev = i === 0 ? { cx: opening.cx, cy: opening.cy, zoom: opening.zoom } : along(beats[i - 1].camera, 1);
  const b = beats[i];
  const local = frame - b.from;
  const now = along(b.camera, local / Math.max(1, b.durationFrames));
  const t = easeInOut(clamp01(local / CARTOON_MOVE_FRAMES));
  return { cx: lerp(prev.cx, now.cx, t), cy: lerp(prev.cy, now.cy, t), zoom: lerp(prev.zoom, now.zoom, t) };
}

/** CSS transform of the stage layer (positioned at the view's top-left, stage px as its unit box) for a camera. */
export function stageTransform(stage: Rect, cam: Camera, view: Rect = CARTOON_VIEW) {
  const s = baseScale(stage, view) * cam.zoom;
  const tx = view.x + view.w / 2 - (cam.cx - stage.x) * s;
  const ty = view.y + view.h / 2 - (cam.cy - stage.y) * s;
  return { scale: s, tx, ty };
}

/**
 * Frame (relative to the run) at which each balloon of the panel appears: a balloon read in the run pops in when
 * its beat starts, a sound effect right after the panel arrives, any other lettering with the panel.
 */
export function balloonEntries(panel: Pick<CartoonPanel, "balloons">, beats: Array<{ from: number; balloon: string | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of panel.balloons) {
    if (!b.rect || !b.text.trim()) continue;
    const beat = beats.find((x) => x.balloon === b.id);
    out[b.id] = beat ? beat.from + 2 : b.kind === "sfx" ? Math.round(CARTOON_TRANSITION_FRAMES * 0.8) : 0;
  }
  return out;
}

/** Consecutive scenes showing the same panel, in order. */
export function cartoonRuns<S extends { from: number; durationFrames: number; cartoon?: CartoonScene | null }>(scenes: S[]): Array<{ panel: string; from: number; durationFrames: number; scenes: S[] }> {
  const runs: Array<{ panel: string; from: number; durationFrames: number; scenes: S[] }> = [];
  for (const s of scenes) {
    const id = s.cartoon?.panel;
    if (!id) continue;
    const last = runs[runs.length - 1];
    if (last && last.panel === id && last.from + last.durationFrames === s.from) {
      last.scenes.push(s);
      last.durationFrames += s.durationFrames;
    } else runs.push({ panel: id, from: s.from, durationFrames: s.durationFrames, scenes: [s] });
  }
  return runs;
}
