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
 * Portrait and square pictures are cover-fitted: the guard picks the anchor,
 * may enlarge the picture (≤ `MAX_ZOOM`) to gain travel, and turns Ken Burns
 * off when the zoom alone would push a face out. A landscape picture is never
 * cropped: `News.tsx` shows it full width on a blurred backdrop on the
 * upper-third line (`landscapeLayout`), so the guard only checks that no
 * overlay covers the faces where the picture puts them.
 */
import { CREDIT_MAX_WIDTH, HEADLINE_BAR, headlinePadding, isLandscape, LANDSCAPE_KEN_BURNS, landscapeLayout, OUTPUT, SAFE_ZONES, textLayout, type Focus, type TextLayoutInput } from "@ai-news/video/schema";

/** Face box normalised to the source picture (0–1, origin top-left). */
export type FaceBox = { x: number; y: number; w: number; h: number; confidence: number };
/** What `faces.ts` stores in `assets.meta.frame`. */
export type FrameFaces = { width: number; height: number; faces: FaceBox[] };

/** `assets.meta.frame` if this picture was analysed before. */
export function storedFrame(meta: unknown): FrameFaces | null {
  const f = (meta as { frame?: FrameFaces } | null)?.frame;
  return f && typeof f.width === "number" && typeof f.height === "number" && Array.isArray(f.faces) ? f : null;
}

/** `assets.meta.section` of a web-video clip: the `[startSec, endSec)` of the source video it was cut from. */
export function storedSection(meta: unknown): [number, number] | null {
  const s = (meta as { section?: unknown } | null)?.section;
  return Array.isArray(s) && s.length === 2 && typeof s[0] === "number" && typeof s[1] === "number" && s[1] > s[0] ? [s[0], s[1]] : null;
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
  /** The kit's caption and headline settings (size, manual position); see `textLayout`. */
  caption: TextLayoutInput["caption"];
  headlineStyle?: TextLayoutInput["headline"];
  hasCaptions: boolean;
  /** The kit draws each shot's media credit (`brand.showSource`); the still being framed usually has one. */
  showSource: boolean;
  hasLogo: boolean;
}): Zone[] {
  const zones: Zone[] = [];
  const left = SAFE_ZONES.left;
  const right = W - SAFE_ZONES.right;
  const at = textLayout({ caption: scene.caption, headline: scene.headlineStyle }, scene.kind);
  if (scene.headline.trim()) {
    const font = at.headline.fontSize;
    const pad = headlinePadding(font);
    const textWidth = at.headline.maxX - at.headline.x - HEADLINE_BAR - 2 * pad.x;
    const { lines, longest } = wrapLines(scene.headline, Math.max(4, Math.floor(textWidth / (font * CHAR_EM))));
    // Anchored by its bottom edge; a longer headline grows upwards.
    zones.push({ name: "headline", x0: at.headline.x, y0: at.headline.y1 - (lines * font * 1.18 + 2 * pad.y), x1: Math.min(at.headline.maxX, at.headline.x + HEADLINE_BAR + 2 * pad.x + longest * font * CHAR_EM), y1: at.headline.y1 });
  }
  // Chunks hold up to 26 characters, which wrap to two lines at the default size.
  if (scene.hasCaptions) zones.push({ name: "captions", x0: at.captions.x0, y0: at.captions.y0, x1: at.captions.x1, y1: at.captions.y1 });
  if (scene.kind === "cta") zones.push({ name: "outro", x0: left, y0: at.outro.y0, x1: right, y1: at.outro.y1 });
  // The shot's media credit pill (`CreditLine` in News.tsx); its width depends on the credit text, so keep the whole strip.
  if (scene.showSource) zones.push({ name: "source", x0: left, y0: H - (SAFE_ZONES.bottom - 60) - 56, x1: left + CREDIT_MAX_WIDTH, y1: H - (SAFE_ZONES.bottom - 60) });
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
  if (isLandscape(frame.width, frame.height)) return frameLandscape(frame, faces, zones);
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

/**
 * A landscape still is drawn full width on a blurred backdrop (`landscapeLayout`),
 * so nothing is cropped and there is no crop to choose: the faces land where the
 * picture puts them, and the only question is whether an overlay covers them.
 */
function frameLandscape(frame: FrameFaces, faces: FaceBox[], zones: Zone[]): Framing {
  const at = landscapeLayout(frame.width, frame.height);
  const grow = LANDSCAPE_KEN_BURNS.in[1] * PUNCH_SCALE;
  const u = {
    x0: clamp(Math.min(...faces.map((f) => f.x - f.w * HEAD_ROOM)), 0, 1),
    y0: clamp(Math.min(...faces.map((f) => f.y - f.h * HEAD_ROOM)), 0, 1),
    x1: clamp(Math.max(...faces.map((f) => f.x + f.w * (1 + HEAD_ROOM))), 0, 1),
    y1: clamp(Math.max(...faces.map((f) => f.y + f.h * (1 + HEAD_ROOM))), 0, 1),
  };
  const box = { x0: u.x0 * W, y0: at.top + u.y0 * at.height, x1: u.x1 * W, y1: at.top + u.y1 * at.height };
  // Worst case while the shot plays: the gentle zoom around the frame's centre.
  const cx = W / 2;
  const cy = at.top + at.height / 2;
  const moving = { x0: cx + (box.x0 - cx) * grow, y0: cy + (box.y0 - cy) * grow, x1: cx + (box.x1 - cx) * grow, y1: cy + (box.y1 - cy) * grow };
  const issues: FramingIssue[] = [];
  if (moving.x0 < 0 || moving.y0 < 0 || moving.x1 > W || moving.y1 > H) issues.push("face_cropped");
  if (zones.some((z) => moving.x0 < z.x1 && moving.x1 > z.x0 && moving.y0 < z.y1 && moving.y1 > z.y0)) issues.push("face_under_text");
  return { ok: issues.length === 0, issues, faces: faces.length, focus: null, kenBurns: true, box: { x0: Math.round(box.x0), y0: Math.round(box.y0), x1: Math.round(box.x1), y1: Math.round(box.y1) } };
}

export const FRAMING_ISSUE_LABEL: Record<FramingIssue, string> = {
  face_cropped: "khuôn mặt bị cắt",
  face_under_text: "khuôn mặt bị chữ che",
  face_off_centre: "khuôn mặt lệch khỏi đường 1/3 trên",
};
