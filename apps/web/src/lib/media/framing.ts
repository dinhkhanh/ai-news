/**
 * Face guard for stills (QA of the 9:16 crop). Pure: given the faces found in
 * a picture (`faces.ts`) and the overlays of the scene it goes into, it picks
 * the cover-crop anchor (`Focus` of timeline JSON v1) and checks three things:
 *
 *  1. no face is cropped by the frame – including the Ken Burns / punch-in zoom;
 *  2. no face sits under a text overlay (headline, captions, source line,
 *     outro, logo) or under the platforms' own UI (bottom caption block, right rail);
 *  3. the faces are centred on the upper-third line: the top two thirds of the
 *     frame are "above the fold" on Reels / TikTok / Shorts, the bottom third
 *     belongs to captions and the platform UI.
 *
 * A landscape picture cover-fitted into 9:16 can only move sideways, so the
 * guard may enlarge it (≤ `MAX_ZOOM`) to gain vertical travel, and turns Ken
 * Burns off when the zoom alone would push a face out.
 */
import { captionBlockHeight, headlineBottom, OUTPUT, OUTRO_HEIGHT, outroBottom, SAFE_ZONES, type Focus } from "@ai-news/video/schema";

/** Face box normalised to the source picture (0–1, origin top-left). */
export type FaceBox = { x: number; y: number; w: number; h: number; confidence: number };
/** What `faces.ts` stores in `assets.meta.frame`. */
export type FrameFaces = { width: number; height: number; faces: FaceBox[] };

/** `assets.meta.frame` if this picture was analysed before. */
export function storedFrame(meta: unknown): FrameFaces | null {
  const f = (meta as { frame?: FrameFaces } | null)?.frame;
  return f && typeof f.width === "number" && typeof f.height === "number" && Array.isArray(f.faces) ? f : null;
}

export type Zone = { name: "headline" | "captions" | "source" | "outro" | "logo" | "platform_bottom" | "platform_right"; x0: number; y0: number; x1: number; y1: number };
export type FramingIssue = "face_cropped" | "face_under_text" | "face_off_centre";
export type Framing = {
  ok: boolean;
  issues: FramingIssue[];
  /** Significant faces the verdict is about; 0 = nothing to guard, centred crop. */
  faces: number;
  focus: Focus | null;
  kenBurns: boolean;
  /** Faces (with head-room) in frame px at rest, for the UI and the build report. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
};

const W: number = OUTPUT.width;
const H: number = OUTPUT.height;

export const MAX_ZOOM = 1.3;
/** Largest scale a still reaches in `News.tsx`: Ken Burns 1.18 × the 1.06 punch-in of a zoom-out shot; Ken Burns also pans ±24 px. */
const KEN_BURNS_SCALE = 1.18 * 1.06;
const PUNCH_SCALE = 1.06;
const KEN_BURNS_PAN_PX = 24;
/** Target: horizontally centred, on the upper-third line. */
export const TARGET = { x: W / 2, y: H / 3 } as const;
/** How far the faces' centre may be from the target and still pass. */
export const TOLERANCE = { x: 0.17 * W, y: 0.12 * H } as const;
/** Head-room added around a detected face box (hair, chin, ears), as a share of the face size. */
const HEAD_ROOM = 0.12;
const MIN_CONFIDENCE = 0.5;
/** Faces smaller than this share of the largest one are background people. */
const MIN_AREA_VS_LARGEST = 0.35;
/** A largest face below this share of the picture height is a crowd / distant shot: nothing to guard. */
const MIN_FACE_HEIGHT = 0.04;

/** Greedy word wrap, the way the headline box breaks its text. */
function wrapLines(text: string, charsPerLine: number): { lines: number; longest: number } {
  let lines = 0;
  let cur = 0;
  let longest = 0;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (cur && cur + 1 + word.length > charsPerLine) {
      longest = Math.max(longest, cur);
      lines += 1;
      cur = word.length;
    } else cur += (cur ? 1 : 0) + word.length;
  }
  if (cur) {
    longest = Math.max(longest, cur);
    lines += 1;
  }
  return { lines, longest };
}

/** Average glyph advance of Be Vietnam Pro / Inter at weight 700–800, in em. */
const CHAR_EM = 0.56;

/** Overlay rectangles of one scene in frame px; mirrors the layout constants of `News.tsx`. */
export function overlayZones(scene: {
  kind: "hook" | "body" | "cta";
  headline: string;
  captionPosition: "bottom" | "middle";
  captionFontSize: number;
  hasCaptions: boolean;
  showSource: boolean;
  hasLogo: boolean;
}): Zone[] {
  const zones: Zone[] = [];
  const left = SAFE_ZONES.left;
  const right = W - SAFE_ZONES.right;
  if (scene.headline.trim()) {
    const big = scene.kind === "hook";
    const font = big ? 66 : 54;
    const padX = big ? 30 : 26;
    const padY = big ? 22 : 16;
    const textWidth = right - left - 14 - 2 * padX;
    const { lines, longest } = wrapLines(scene.headline, Math.floor(textWidth / (font * CHAR_EM)));
    // Bottom-anchored above the captions (lower third); a longer headline grows upwards.
    const y1 = H - headlineBottom({ position: scene.captionPosition, fontSize: scene.captionFontSize }, scene.kind);
    zones.push({ name: "headline", x0: left, y0: y1 - (lines * font * 1.18 + 2 * padY), x1: Math.min(right, left + 14 + 2 * padX + longest * font * CHAR_EM), y1 });
  }
  if (scene.hasCaptions) {
    // Chunks hold up to 26 characters, which wrap to two lines at the default size.
    const h = captionBlockHeight(scene.captionFontSize);
    const y0 = scene.captionPosition === "middle" ? H / 2 - 60 : H - (SAFE_ZONES.bottom + 30) - h;
    zones.push({ name: "captions", x0: left, y0, x1: right, y1: y0 + h });
  }
  if (scene.kind === "cta") {
    const y1 = H - outroBottom({ position: scene.captionPosition, fontSize: scene.captionFontSize });
    zones.push({ name: "outro", x0: left, y0: y1 - OUTRO_HEIGHT, x1: right, y1 });
  }
  if (scene.showSource) zones.push({ name: "source", x0: left, y0: H - (SAFE_ZONES.bottom - 60) - 56, x1: left + 500, y1: H - (SAFE_ZONES.bottom - 60) });
  if (scene.hasLogo) zones.push({ name: "logo", x0: W - (SAFE_ZONES.right - 60) - 300, y0: SAFE_ZONES.top - 120, x1: W - (SAFE_ZONES.right - 60), y1: SAFE_ZONES.top - 30 });
  zones.push({ name: "platform_bottom", x0: 0, y0: H - SAFE_ZONES.bottom, x1: W, y1: H });
  zones.push({ name: "platform_right", x0: right, y0: H / 2, x1: W, y1: H });
  return zones;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Faces worth guarding: confident, and not background people next to the main subject. */
export function significantFaces(frame: FrameFaces): FaceBox[] {
  const faces = frame.faces.filter((f) => f.confidence >= MIN_CONFIDENCE && f.w > 0 && f.h > 0);
  const largest = Math.max(0, ...faces.map((f) => f.w * f.h));
  const tallest = Math.max(0, ...faces.map((f) => f.h));
  if (tallest < MIN_FACE_HEIGHT) return [];
  return faces.filter((f) => f.w * f.h >= largest * MIN_AREA_VS_LARGEST);
}

type Attempt = { focus: Focus; kenBurns: boolean; issues: FramingIssue[]; box: NonNullable<Framing["box"]>; distance: number };

function attempt(frame: FrameFaces, u: { x0: number; y0: number; x1: number; y1: number }, zones: Zone[], zoom: number, kenBurns: boolean): Attempt {
  const s = Math.max(W / frame.width, H / frame.height) * zoom;
  const rw = frame.width * s;
  const rh = frame.height * s;
  const ox = rw - W;
  const oy = rh - H;
  const bw = (u.x1 - u.x0) * rw;
  const bh = (u.y1 - u.y0) * rh;
  const grow = kenBurns ? KEN_BURNS_SCALE : PUNCH_SCALE;
  const pan = kenBurns ? KEN_BURNS_PAN_PX * KEN_BURNS_SCALE : 0;
  // Clear vertical band between the full-width overlays above and below the target line.
  let top = 0;
  let bottom = H;
  for (const z of zones) {
    if (z.name === "logo" || z.name === "platform_right") continue;
    if ((z.y0 + z.y1) / 2 < TARGET.y) top = Math.max(top, z.y1);
    else bottom = Math.min(bottom, z.y0);
  }
  const halfH = (bh * grow) / 2;
  const wantY = top + halfH <= bottom - halfH ? clamp(TARGET.y, top + halfH, bottom - halfH) : (top + bottom) / 2;
  const ucx = ((u.x0 + u.x1) / 2) * rw;
  const ucy = ((u.y0 + u.y1) / 2) * rh;
  const px = ox > 0.5 ? clamp((ucx - TARGET.x) / ox, 0, 1) : 0.5;
  const py = oy > 0.5 ? clamp((ucy - wantY) / oy, 0, 1) : 0.5;
  const cx = ucx - px * ox;
  const cy = ucy - py * oy;
  const box = { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 };
  // Worst case while the shot plays: scaled around the faces' centre, plus the pan.
  const moving = { x0: cx - (bw * grow) / 2 - pan, y0: cy - halfH, x1: cx + (bw * grow) / 2 + pan, y1: cy + halfH };
  const issues: FramingIssue[] = [];
  if (moving.x0 < 0 || moving.y0 < 0 || moving.x1 > W || moving.y1 > H) issues.push("face_cropped");
  if (zones.some((z) => moving.x0 < z.x1 && moving.x1 > z.x0 && moving.y0 < z.y1 && moving.y1 > z.y0)) issues.push("face_under_text");
  if (Math.abs(cx - TARGET.x) > TOLERANCE.x || Math.abs(cy - TARGET.y) > TOLERANCE.y) issues.push("face_off_centre");
  return {
    focus: { x: round(px), y: round(py), zoom: round(zoom, 2), originX: round(clamp(cx / W, 0, 1)), originY: round(clamp(cy / H, 0, 1)) },
    kenBurns,
    issues,
    box: { x0: Math.round(box.x0), y0: Math.round(box.y0), x1: Math.round(box.x1), y1: Math.round(box.y1) },
    distance: Math.hypot(cx - TARGET.x, cy - TARGET.y),
  };
}

/**
 * Best crop for a still in a scene with these overlays. Prefers, in order:
 * no issues, Ken Burns kept, the least zoom. When nothing passes, the attempt
 * with the fewest issues (then the closest to the target) is returned with
 * `ok: false` so a caller that has no better picture can still use it.
 */
export function frameStill(frame: FrameFaces | null, zones: Zone[]): Framing {
  if (!frame || frame.width <= 0 || frame.height <= 0) return { ok: true, issues: [], faces: 0, focus: null, kenBurns: true, box: null };
  const faces = significantFaces(frame);
  if (faces.length === 0) return { ok: true, issues: [], faces: 0, focus: null, kenBurns: true, box: null };
  const u = {
    x0: clamp(Math.min(...faces.map((f) => f.x - f.w * HEAD_ROOM)), 0, 1),
    y0: clamp(Math.min(...faces.map((f) => f.y - f.h * HEAD_ROOM)), 0, 1),
    x1: clamp(Math.max(...faces.map((f) => f.x + f.w * (1 + HEAD_ROOM))), 0, 1),
    y1: clamp(Math.max(...faces.map((f) => f.y + f.h * (1 + HEAD_ROOM))), 0, 1),
  };
  let best: Attempt | null = null;
  for (const kenBurns of [true, false]) {
    for (let zoom = 1; zoom <= MAX_ZOOM + 1e-9; zoom += 0.05) {
      const a = attempt(frame, u, zones, zoom, kenBurns);
      if (a.issues.length === 0) return { ok: true, issues: [], faces: faces.length, focus: a.focus, kenBurns, box: a.box };
      if (!best || a.issues.length < best.issues.length || (a.issues.length === best.issues.length && a.distance < best.distance - 1)) best = a;
    }
  }
  return { ok: false, issues: best!.issues, faces: faces.length, focus: best!.focus, kenBurns: best!.kenBurns, box: best!.box };
}

export const FRAMING_ISSUE_LABEL: Record<FramingIssue, string> = {
  face_cropped: "khuôn mặt bị cắt",
  face_under_text: "khuôn mặt bị chữ che",
  face_off_centre: "khuôn mặt lệch khỏi đường 1/3 trên",
};
