import { z } from "zod";

/** Output spec (docs/PLAN.md §1). */
export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;

/** Safe zones in px for 1080x1920 (platform UI overlays: top bar, right rail, bottom caption/CTA). */
export const SAFE_ZONES = { top: 220, bottom: 420, left: 60, right: 180 } as const;

/** Room kept for the caption block: a chunk wraps to two lines at most (line height 1.35 + padding). */
export const captionBlockHeight = (fontSize: number) => 2 * fontSize * 1.35 + 28;

/** Room kept for the outro (channel line + credits) of the closing scene. */
export const OUTRO_HEIGHT = 160;
/** The hook's headline is this much bigger than the kit's headline size. */
export const HOOK_HEADLINE_SCALE = 66 / 54;
export const DEFAULT_HEADLINE_FONT_SIZE = 54;
const TEXT_GAP = 24;

/** Padding of the headline card, proportional to its font size (16/26 px at the default 54). */
export const headlinePadding = (fontSize: number) => ({ x: Math.round(fontSize * 0.48), y: Math.round(fontSize * 0.3) });
/** Accent bar on the left of the headline card. */
export const HEADLINE_BAR = 14;

/** What the text layout needs of a brand; every field may be missing in timelines stored before it existed. */
export type TextLayoutInput = {
  caption: { position: "bottom" | "middle"; fontSize: number; x?: number | null; y?: number | null };
  headline?: { fontSize?: number; x?: number | null; y?: number | null } | null;
};

/**
 * Where the text sits, in px of the 1080×1920 frame (origin top-left). One
 * definition for `News.tsx`, the face guard's `overlayZones` and the brand page.
 *
 * Automatic (no manual position): captions sit above the bottom safe zone, or
 * mid-frame; the headline lives in the lower third right above the captions
 * and grows upwards (the top of a picture is where faces are), or takes the
 * bottom-caption slot when the captions are in the upper half; on the closing
 * scene the outro sits above the captions and the headline above the outro.
 *
 * Manual: `caption.x` = horizontal centre of the caption block, `caption.y` =
 * its bottom edge; `headline.x` = left edge of the card, `headline.y` = its
 * bottom edge (so a longer headline still grows upwards). A manual caption
 * moves the automatic headline with it.
 */
export function textLayout(brand: TextLayoutInput, kind: "hook" | "body" | "cta") {
  const c = brand.caption;
  const h = captionBlockHeight(c.fontSize);
  const captions =
    c.y != null ? { y0: c.y - h, y1: c.y, anchor: "bottom" as const } : c.position === "middle" ? { y0: OUTPUT.height / 2 - 60, y1: OUTPUT.height / 2 - 60 + h, anchor: "top" as const } : { y0: OUTPUT.height - (SAFE_ZONES.bottom + 30) - h, y1: OUTPUT.height - (SAFE_ZONES.bottom + 30), anchor: "bottom" as const };
  const autoCentre = (SAFE_ZONES.left + OUTPUT.width - SAFE_ZONES.right) / 2;
  // Free slot for headline / outro: right above captions that sit in the lower half, else the bottom-caption slot.
  const slot = captions.y0 > OUTPUT.height / 2 ? captions.y0 - TEXT_GAP : OUTPUT.height - (SAFE_ZONES.bottom + 30);
  const outroY1 = Math.min(slot, OUTPUT.height - (SAFE_ZONES.bottom + 140));
  const base = brand.headline?.fontSize ?? DEFAULT_HEADLINE_FONT_SIZE;
  return {
    captions: (() => {
      const centreX = c.x ?? autoCentre;
      // As wide as the safe zones allow, narrower when the block is pushed towards an edge (always centred on `centreX`).
      const half = Math.max(150, Math.min((OUTPUT.width - SAFE_ZONES.left - SAFE_ZONES.right) / 2, centreX - 20, OUTPUT.width - 20 - centreX));
      return { ...captions, centreX, x0: centreX - half, x1: centreX + half };
    })(),
    outro: { y0: outroY1 - OUTRO_HEIGHT, y1: outroY1 },
    headline: {
      x: brand.headline?.x ?? SAFE_ZONES.left,
      /** Right limit of the card: the platform's right rail, but never less than 300 px of room. */
      maxX: Math.max(OUTPUT.width - SAFE_ZONES.right, Math.min(OUTPUT.width, (brand.headline?.x ?? SAFE_ZONES.left) + 300)),
      y1: brand.headline?.y ?? (kind === "cta" ? outroY1 - OUTRO_HEIGHT - TEXT_GAP : slot),
      fontSize: kind === "hook" ? Math.round(base * HOOK_HEADLINE_SCALE) : base,
    },
  };
}

export const testCardSchema = z.object({
  title: z.string().default("ai-news test render"),
  durationSec: z.number().int().min(3).max(60).default(6),
  fps: z.number().int().default(OUTPUT.fps),
});
export type TestCardProps = z.infer<typeof testCardSchema>;

/** Fonts bundled with the News composition (loaded via @remotion/google-fonts). */
export const BRAND_FONTS = ["Be Vietnam Pro", "Inter"] as const;

/**
 * How the logo moves. Every motion starts with the same entrance (the logo turns in from its edge) and then repeats
 * every `LOGO_MOTION_PERIOD_SEC`: `flip` = a full turn around the vertical axis like a coin, `tilt` = it keeps
 * floating, pitching and yawing a few degrees, `spin` = a full turn in the plane (round marks), `pulse` = a short
 * heartbeat; `none` = still.
 */
export const LOGO_MOTIONS = ["flip", "tilt", "spin", "pulse", "none"] as const;
export type LogoMotion = (typeof LOGO_MOTIONS)[number];
export const LOGO_MOTION_PERIOD_SEC = 6;

/** Where the brand overlay PNG sits in the layer stack. */
export const OVERLAY_LAYERS = ["under_text", "top"] as const;
export type OverlayLayer = (typeof OVERLAY_LAYERS)[number];

/**
 * Brand kit as embedded in a timeline so a render is reproducible even if the
 * workspace kit changes later. Colours are CSS colours.
 */
export const brandSchema = z.object({
  name: z.string().default("ai-news"),
  colours: z.object({
    primary: z.string().default("#0f172a"),
    accent: z.string().default("#f59e0b"),
    background: z.string().default("#0b1220"),
    text: z.string().default("#ffffff"),
    captionBg: z.string().default("rgba(0,0,0,0.72)"),
    captionHighlight: z.string().default("#fbbf24"),
  }),
  fonts: z.object({
    heading: z.enum(BRAND_FONTS).default("Be Vietnam Pro"),
    body: z.enum(BRAND_FONTS).default("Be Vietnam Pro"),
    caption: z.enum(BRAND_FONTS).default("Be Vietnam Pro"),
  }),
  caption: z.object({
    position: z.enum(["bottom", "middle"]).default("bottom"),
    fontSize: z.number().int().min(36).max(96).default(64),
    uppercase: z.boolean().default(false),
    highlightWords: z.boolean().default(true),
    /** Manual position in frame px (see `textLayout`): centre of the block / its bottom edge; null = automatic. */
    x: z.number().int().min(0).max(OUTPUT.width).nullable().default(null),
    y: z.number().int().min(0).max(OUTPUT.height).nullable().default(null),
  }),
  /** Headline card: size of body headlines (the hook is `HOOK_HEADLINE_SCALE` bigger); `x` = left edge, `y` = bottom edge, null = automatic. */
  headline: z
    .object({
      fontSize: z.number().int().min(28).max(120).default(DEFAULT_HEADLINE_FONT_SIZE),
      x: z.number().int().min(0).max(OUTPUT.width).nullable().default(null),
      y: z.number().int().min(0).max(OUTPUT.height).nullable().default(null),
    })
    .prefault({}),
  /** Absolute URL at render time (resolved from an R2 key by the app). */
  logoSrc: z.string().nullable().default(null),
  logoMotion: z.enum(LOGO_MOTIONS).default("flip"),
  /**
   * Full-frame 1080×1920 transparent PNG (frame, lower band, corner graphics…)
   * laid over every scene that has `overlay` on, from the scene's first frame
   * to its last, without the scene fade. R2 key in storage, URL at render time.
   */
  overlaySrc: z.string().nullable().default(null),
  /** `under_text`: above the pictures, below headline / captions / logo. `top`: above everything. */
  overlayLayer: z.enum(OVERLAY_LAYERS).default("under_text"),
  showSource: z.boolean().default(true),
  /** Short label shown in the CTA/outro, e.g. the channel name. */
  outroText: z.string().nullable().default(null),
});
export type Brand = z.infer<typeof brandSchema>;

/**
 * Timeline JSON v1 (docs/PLAN.md §4.6). Stored per version in `timelines.json`
 * with R2 *keys* in every `src`; the app resolves keys to presigned URLs right
 * before rendering (see apps/web/src/lib/media/timeline.ts). The composition
 * only ever sees URLs.
 */
/**
 * Where a cover-fitted still is anchored, from the face guard
 * (apps/web/src/lib/media/framing.ts): `x` / `y` are the share of the overflow
 * hidden on the left / top (CSS `object-position`, 0–1), `zoom` enlarges the
 * cover fit so a landscape picture can also be moved vertically, and
 * `originX` / `originY` are where the faces end up in the frame (0–1) – the
 * Ken Burns move scales around that point so it never pushes a face out.
 */
export const focusSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(1.5).default(1),
  originX: z.number().min(0).max(1).default(0.5),
  originY: z.number().min(0).max(1).default(0.5),
});
export type Focus = z.infer<typeof focusSchema>;

export const visualSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("video"),
    src: z.string(),
    /** Seconds into the clip to start from. */
    trimStartSec: z.number().nonnegative().default(0),
    /** Clip length in seconds; the scene loops it when the scene is longer. */
    clipDurationSec: z.number().positive(),
    fit: z.enum(["cover", "contain"]).default("cover"),
    muted: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("image"),
    src: z.string(),
    kenBurns: z.boolean().default(true),
    /** Null = centred cover fit (no faces found, or never checked). */
    focus: focusSchema.nullable().default(null),
  }),
  z.object({ kind: z.literal("solid") }),
]);
export type Visual = z.infer<typeof visualSchema>;

/**
 * One visual within a scene. Scenes longer than ~5 s are cut into several
 * shots so the picture changes every 4–5 s; `from` is relative to the scene.
 */
export const shotSchema = z.object({
  from: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  visual: visualSchema,
  credit: z.string().nullable().default(null),
});
export type Shot = z.infer<typeof shotSchema>;

/** Longest a single shot should stay on screen. */
export const MAX_SHOT_SEC = 5;

export const sceneSchema = z.object({
  id: z.string(),
  kind: z.enum(["hook", "body", "cta"]),
  from: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  headline: z.string().default(""),
  /** First shot (kept for older timelines and thumbnails); `shots` is authoritative when non-empty. */
  visual: visualSchema,
  /** Consecutive shots covering the scene; empty = the single `visual` for the whole scene. */
  shots: z.array(shotSchema).default([]),
  /** Provenance for the on-screen attribution line. */
  credit: z.string().nullable().default(null),
  /**
   * This scene's own voice-over file (R2 key, resolved to a URL for playback).
   * Only played when `audio.mixSrc` is null (editor preview before a re-mix);
   * Lambda renders always use the mixed track.
   */
  voiceSrc: z.string().nullable().default(null),
  /** Show the brand overlay PNG (`brand.overlaySrc`) on this scene; switched per scene in the editor. */
  overlay: z.boolean().default(true),
});
export type TimelineScene = z.infer<typeof sceneSchema>;

export const captionSchema = z.object({
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().positive(),
  words: z.array(z.object({ w: z.string(), s: z.number(), e: z.number() })).default([]),
});
export type Caption = z.infer<typeof captionSchema>;

export const timelineSchema = z.object({
  version: z.literal(1),
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  durationFrames: z.number().int().positive(),
  language: z.enum(["vi", "en"]),
  title: z.string(),
  source: z.object({ name: z.string().nullable(), url: z.string() }),
  brand: brandSchema,
  scenes: z.array(sceneSchema),
  captions: z.array(captionSchema),
  audio: z.object({
    /** Final mix (VO normalised to -16 LUFS + music ducked). Null = silent render. */
    mixSrc: z.string().nullable(),
    voiceSrc: z.string().nullable(),
    musicSrc: z.string().nullable(),
    musicGainDb: z.number().default(-12),
  }),
  /** Credits rendered in the outro, e.g. "Video: Pexels · Music: Mubert". */
  attribution: z.array(z.string()).default([]),
  /** Cover frame chosen in the editor (seconds); null = automatic (~1.2 s in). */
  coverAtSec: z.number().nonnegative().nullable().default(null),
});
export type Timeline = z.infer<typeof timelineSchema>;
