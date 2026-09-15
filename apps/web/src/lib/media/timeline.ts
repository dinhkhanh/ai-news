/**
 * Timeline JSON v1 builder (docs/PLAN.md §4.6). Pure: takes the script scenes,
 * per-scene voice timings, chosen visuals and music, returns the timeline with
 * R2 keys in every `src`. Unit-testable; URL resolution happens in
 * timeline-resolve.ts right before a render.
 */
import { timelineSchema, type Brand, type Timeline, type Visual } from "@ai-news/video/schema";
import type { TimedWord } from "./align";
import { chunkCaptions, type CaptionChunk } from "./captions";

export type SceneVoiceInput = { key: string; durationMs: number; words: TimedWord[] };
export type SceneVisualInput =
  | { kind: "video"; key: string; clipDurationSec: number; credit: string | null }
  | { kind: "image"; key: string; credit: string | null }
  | null;

export type BuildInput = {
  title: string;
  language: "vi" | "en";
  source: { name: string | null; url: string };
  brand: Brand;
  scenes: Array<{
    id: string;
    kind: "hook" | "body" | "cta";
    onScreenText: string;
    durationSec: number;
    voice: SceneVoiceInput | null;
    visual: SceneVisualInput;
    /** Extra hold after the voice-over ends (editor), 0–5000 ms. */
    holdMs?: number;
    /** Caption chunks relative to this scene's voice start; default = automatic chunking of `voice.words`. */
    captions?: CaptionChunk[];
  }>;
  music: { key: string; gainDb?: number; attribution: string } | null;
  audio: { mixKey: string | null; voiceKey: string | null };
  /** Cover frame chosen in the editor; null = automatic. */
  coverAtSec?: number | null;
  /** Silence between scenes and after the last one. */
  gapMs?: number;
  tailMs?: number;
  leadMs?: number;
};

export type SceneTiming = { id: string; atSec: number; fromFrame: number; durationFrames: number; durationMs: number };

const FPS = 30;

/** Scene start offsets: needed before the audio mix exists (the mix places VO segments at these offsets). */
export function sceneTimings(input: Pick<BuildInput, "scenes" | "gapMs" | "tailMs" | "leadMs">): { timings: SceneTiming[]; durationSec: number } {
  const gap = input.gapMs ?? 350;
  const tail = input.tailMs ?? 900;
  const lead = input.leadMs ?? 250;
  let cursorMs = 0;
  const timings: SceneTiming[] = input.scenes.map((s, i) => {
    const last = i === input.scenes.length - 1;
    const voiceMs = s.voice?.durationMs ?? Math.round(s.durationSec * 1000);
    const hold = Math.min(5000, Math.max(0, Math.round(s.holdMs ?? 0)));
    const durationMs = (i === 0 ? lead : 0) + voiceMs + hold + (last ? tail : gap);
    const fromFrame = Math.round((cursorMs / 1000) * FPS);
    const endFrame = Math.round(((cursorMs + durationMs) / 1000) * FPS);
    const t = { id: s.id, atSec: (cursorMs + (i === 0 ? lead : 0)) / 1000, fromFrame, durationFrames: Math.max(1, endFrame - fromFrame), durationMs };
    cursorMs += durationMs;
    return t;
  });
  return { timings, durationSec: Math.round(cursorMs) / 1000 };
}

export function buildTimeline(input: BuildInput): { timeline: Timeline; durationSec: number; timings: SceneTiming[] } {
  const { timings, durationSec } = sceneTimings(input);
  const credits = new Set<string>();
  const scenes = input.scenes.map((s, i) => {
    const t = timings[i];
    let visual: Visual;
    if (s.visual?.kind === "video") visual = { kind: "video", src: s.visual.key, trimStartSec: 0, clipDurationSec: Math.max(0.5, s.visual.clipDurationSec), fit: "cover", muted: true };
    else if (s.visual?.kind === "image") visual = { kind: "image", src: s.visual.key, kenBurns: true };
    else visual = { kind: "solid" };
    if (s.visual?.credit) credits.add(s.visual.credit);
    return { id: s.id, kind: s.kind, from: t.fromFrame, durationFrames: t.durationFrames, headline: s.onScreenText, visual, credit: s.visual?.credit ?? null, voiceSrc: s.voice?.key ?? null };
  });
  const captions = input.scenes.flatMap((s, i) => {
    if (!s.voice) return [];
    const off = Math.round(timings[i].atSec * 1000);
    const chunks = s.captions ?? chunkCaptions(s.voice.words);
    return chunks.map((c) => ({ text: c.text, startMs: c.startMs + off, endMs: c.endMs + off, words: c.words.map((w) => ({ w: w.w, s: w.s + off, e: w.e + off })) }));
  });
  if (input.music) credits.add(input.music.attribution);
  const timeline = timelineSchema.parse({
    version: 1,
    fps: FPS,
    width: 1080,
    height: 1920,
    durationFrames: Math.max(FPS, Math.round(durationSec * FPS)),
    language: input.language,
    title: input.title,
    source: input.source,
    brand: input.brand,
    scenes,
    captions,
    audio: { mixSrc: input.audio.mixKey, voiceSrc: input.audio.voiceKey, musicSrc: input.music?.key ?? null, musicGainDb: input.music?.gainDb ?? -12 },
    attribution: [...credits],
    coverAtSec: input.coverAtSec ?? null,
  });
  return { timeline, durationSec, timings };
}
