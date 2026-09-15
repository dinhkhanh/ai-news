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

/**
 * Timeline JSON v1 (phase 3/4 fill this in). Kept here so the web app, the
 * editor and the renderer share one contract from the start.
 */
export const timelineSchema = z.object({
  version: z.literal(1),
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  durationFrames: z.number().int().positive(),
  brandKitId: z.string().optional(),
  tracks: z.object({
    video: z.array(
      z.object({
        id: z.string(),
        assetUrl: z.string().url(),
        from: z.number().int().nonnegative(),
        durationFrames: z.number().int().positive(),
        trimStartSec: z.number().nonnegative().default(0),
        fit: z.enum(["cover", "contain"]).default("cover"),
        kenBurns: z.boolean().default(false),
      }),
    ),
    overlays: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["headline", "lower_third", "source", "logo", "intro", "outro"]),
        text: z.string().optional(),
        from: z.number().int().nonnegative(),
        durationFrames: z.number().int().positive(),
      }),
    ),
    captions: z.array(
      z.object({
        text: z.string(),
        startMs: z.number().nonnegative(),
        endMs: z.number().positive(),
        words: z.array(z.object({ w: z.string(), s: z.number(), e: z.number() })).optional(),
      }),
    ),
    voice: z.object({ url: z.string().url(), gainDb: z.number().default(0) }).optional(),
    music: z.object({ url: z.string().url(), gainDb: z.number().default(-12), fadeOutSec: z.number().default(1.5) }).optional(),
  }),
});
export type Timeline = z.infer<typeof timelineSchema>;
