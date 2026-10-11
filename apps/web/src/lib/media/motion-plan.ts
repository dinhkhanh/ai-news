/**
 * Motion graphics planning (pure, tested): which scenes of a build become a
 * motion graphic and what timing a graphic is designed against. The Claude
 * calls live in `lib/llm/motion.ts`; the composition in
 * `@ai-news/video` (`Motion.tsx`, `HyperFramesShot.tsx`).
 */
import type { MotionMode } from "@ai-news/video/motion";
import type { TimedWord } from "./align";

type PlanScene = { id: string; kind: "hook" | "body" | "cta"; voiceover: string };

/** In `auto` mode no more than this share of the scenes (rounded up) becomes a graphic: it is an accent, not the video. */
export const AUTO_MOTION_SHARE = 0.5;

export const autoMotionCap = (sceneCount: number) => Math.max(1, Math.ceil(sceneCount * AUTO_MOTION_SHARE));

/** Figures, percentages, money, dates: what a graphic shows better than a photo. */
const FIGURE = /\d/;

/**
 * Scenes that become motion graphics. `all`: every scene. `auto`: Claude's
 * picks (unknown ids dropped, script order kept, capped), or – when that call
 * failed (`picks` null) – the scenes that state a figure, closing scene excluded.
 */
export function motionScenes(mode: MotionMode, scenes: PlanScene[], picks: string[] | null): string[] {
  if (mode === "off") return [];
  if (mode === "all") return scenes.map((s) => s.id);
  const cap = autoMotionCap(scenes.length);
  if (picks) {
    const wanted = new Set(picks);
    return scenes.filter((s) => wanted.has(s.id)).slice(0, cap).map((s) => s.id);
  }
  return scenes.filter((s) => s.kind !== "cta" && FIGURE.test(s.voiceover)).slice(0, cap).map((s) => s.id);
}

/**
 * The scene's words as heard during one shot: times in seconds from the shot's
 * first frame. `voiceStartSec` = when the voice-over starts, counted from the
 * shot's start (negative when the shot begins mid-sentence). Words outside the
 * shot are dropped.
 */
export function shotWords(words: TimedWord[], voiceStartSec: number, durationSec: number): Array<{ w: string; at: number }> {
  return words
    .map((w) => ({ w: w.w, at: Math.round((voiceStartSec + w.s / 1000) * 100) / 100 }))
    .filter((w) => w.at >= -0.05 && w.at < durationSec);
}

/** "[0.25] Hà [0.51] Nội …" – compact word timing for the prompt. */
export const timingLine = (words: Array<{ w: string; at: number }>) => words.map((w) => `[${Math.max(0, w.at).toFixed(2)}] ${w.w}`).join(" ");
