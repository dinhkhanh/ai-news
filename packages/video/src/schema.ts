import { z } from "zod";

/** Output spec (docs/PLAN.md §1). */
export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;

/** Safe zones in px for 1080x1920 (platform UI overlays: top bar, right rail, bottom caption/CTA). */
export const SAFE_ZONES = { top: 220, bottom: 420, left: 60, right: 180 } as const;

export const testCardSchema = z.object({
  title: z.string().default("ai-news test render"),
  durationSec: z.number().int().min(3).max(60).default(6),
  fps: z.number().int().default(OUTPUT.fps),
});
export type TestCardProps = z.infer<typeof testCardSchema>;

/** Fonts bundled with the News composition (loaded via @remotion/google-fonts). */
export const BRAND_FONTS = ["Be Vietnam Pro", "Inter"] as const;

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
  }),
  /** Absolute URL at render time (resolved from an R2 key by the app). */
  logoSrc: z.string().nullable().default(null),
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
