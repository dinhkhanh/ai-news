/**
 * Editor document (docs/PLAN.md §4.7 "Review" + phase 4). The editor edits a
 * *source* description of the video — scenes with their voice file and word
 * timings, chosen visual, caption chunks, music, cover — and every save
 * rebuilds timeline JSON v1 from it with `buildTimeline`. The document is
 * stored next to the timeline in `timelines.build_json.doc`; timelines built
 * before phase 4 are reconstructed from their JSON (`docFromTimeline`).
 * Pure module (client + server + tests): R2 keys only, never URLs.
 */
import { brandSchema, type Timeline } from "@ai-news/video/schema";
import { z } from "zod";
import { proportionalTimings, type TimedWord } from "./align";
import { chunkCaptions, type CaptionChunk } from "./captions";
import { buildTimeline, type BuildInput, type SceneVisualInput } from "./timeline";

const timedWordSchema = z.object({ w: z.string(), s: z.number(), e: z.number() });
const captionChunkSchema = z.object({ text: z.string().max(200), startMs: z.number(), endMs: z.number(), words: z.array(timedWordSchema) });

export const editorVisualSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("video"),
    key: z.string().min(1),
    clipDurationSec: z.number().positive(),
    trimStartSec: z.number().nonnegative().default(0),
    credit: z.string().nullable().default(null),
    assetId: z.string().nullable().default(null),
    thumbnailUrl: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal("image"),
    key: z.string().min(1),
    kenBurns: z.boolean().default(true),
    credit: z.string().nullable().default(null),
    assetId: z.string().nullable().default(null),
    thumbnailUrl: z.string().nullable().default(null),
  }),
  z.object({ kind: z.literal("solid") }),
]);
export type EditorVisual = z.infer<typeof editorVisualSchema>;

export const editorSceneSchema = z.object({
  id: z.string().min(1).max(16),
  kind: z.enum(["hook", "body", "cta"]),
  onScreenText: z.string().max(120),
  /** Spoken text (source for a voice regeneration); words[] carries the timings actually synthesised. */
  voiceover: z.string().max(2000),
  brollTerms: z.array(z.string().max(80)).max(6).default([]),
  durationSec: z.number().positive(),
  voice: z.object({ key: z.string().min(1), durationMs: z.number().positive(), words: z.array(timedWordSchema) }).nullable(),
  visual: editorVisualSchema,
  holdMs: z.number().min(0).max(5000).default(0),
  /** Caption chunks relative to the scene's voice start; null = automatic chunking of voice.words. */
  captions: z.array(captionChunkSchema).nullable().default(null),
});
export type EditorScene = z.infer<typeof editorSceneSchema>;

export const editorMusicSchema = z.object({
  key: z.string().min(1),
  gainDb: z.number().min(-30).max(0).default(-12),
  attribution: z.string(),
  title: z.string(),
  source: z.enum(["mubert", "library"]),
  licence: z.string().default(""),
});
export type EditorMusic = z.infer<typeof editorMusicSchema>;

export const editorDocSchema = z.object({
  v: z.literal(1).default(1),
  title: z.string().max(200),
  language: z.enum(["vi", "en"]),
  source: z.object({ name: z.string().nullable(), url: z.string() }),
  brand: brandSchema,
  scenes: z.array(editorSceneSchema).min(1).max(30),
  music: editorMusicSchema.nullable(),
  coverAtSec: z.number().nonnegative().nullable().default(null),
});
export type EditorDoc = z.infer<typeof editorDocSchema>;

const FPS = 30;
const LEAD_MS = 250;
const GAP_MS = 350;
const TAIL_MS = 900;

/** Caption chunks for a scene (explicit edits, else automatic). */
export function sceneCaptions(scene: EditorScene): CaptionChunk[] {
  if (!scene.voice) return [];
  return scene.captions ?? chunkCaptions(scene.voice.words);
}

/** Replace a caption chunk's text; the new words share the chunk's time span proportionally. */
export function setCaptionText(chunk: CaptionChunk, text: string): CaptionChunk {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return { ...chunk, text: "", words: [] };
  const timed = proportionalTimings(words, Math.max(120, chunk.endMs - chunk.startMs), chunk.startMs);
  return { text: words.join(" "), startMs: chunk.startMs, endMs: chunk.endMs, words: timed };
}

function toVisualInput(v: EditorVisual): SceneVisualInput {
  if (v.kind === "video") return { kind: "video", key: v.key, clipDurationSec: v.clipDurationSec, credit: v.credit };
  if (v.kind === "image") return { kind: "image", key: v.key, credit: v.credit };
  return null;
}

/**
 * Timeline JSON from the document. `audio` is the mixed track for this exact
 * audio layout (see `audioSignature`); null = preview mode, the composition
 * plays each scene's own voice file instead.
 */
export function buildFromDoc(doc: EditorDoc, audio: { mixKey: string; voiceKey: string | null } | null) {
  const input: BuildInput = {
    title: doc.title,
    language: doc.language,
    source: doc.source,
    brand: doc.brand,
    scenes: doc.scenes.map((s) => ({
      id: s.id,
      kind: s.kind,
      onScreenText: s.onScreenText,
      durationSec: s.durationSec,
      voice: s.voice,
      visual: toVisualInput(s.visual),
      holdMs: s.holdMs,
      captions: s.captions ?? undefined,
    })),
    music: doc.music ? { key: doc.music.key, gainDb: doc.music.gainDb, attribution: doc.music.attribution } : null,
    audio: { mixKey: audio?.mixKey ?? null, voiceKey: audio?.voiceKey ?? null },
    coverAtSec: doc.coverAtSec,
    leadMs: LEAD_MS,
    gapMs: GAP_MS,
    tailMs: TAIL_MS,
  };
  const built = buildTimeline(input);
  // Video visuals keep their trim/kenBurns settings, which the generic builder does not know about.
  built.timeline.scenes = built.timeline.scenes.map((sc, i) => {
    const v = doc.scenes[i].visual;
    if (sc.visual.kind === "video" && v.kind === "video") return { ...sc, visual: { ...sc.visual, trimStartSec: v.trimStartSec } };
    if (sc.visual.kind === "image" && v.kind === "image") return { ...sc, visual: { ...sc.visual, kenBurns: v.kenBurns } };
    return sc;
  });
  return built;
}

/** Everything the audio mix depends on. Equal signatures → the previous mix file can be reused. */
export function audioSignature(doc: EditorDoc) {
  return JSON.stringify({
    scenes: doc.scenes.map((s) => [s.voice?.key ?? null, s.voice?.durationMs ?? Math.round(s.durationSec * 1000), s.holdMs]),
    music: doc.music ? [doc.music.key, doc.music.gainDb] : null,
  });
}

/** Voice segment offsets for the media-Lambda mix (same layout as `buildTimeline`). */
export function voicePlacement(doc: EditorDoc): { voice: Array<{ key: string; atSec: number }>; durationSec: number } {
  const { timings, durationSec } = buildFromDoc(doc, null);
  const voice = doc.scenes.flatMap((s, i) => (s.voice ? [{ key: s.voice.key, atSec: timings[i].atSec }] : []));
  return { voice, durationSec };
}

/** Every R2 key referenced by the document (for presigning previews and for ownership checks on save). */
export function docKeys(doc: EditorDoc): string[] {
  const keys = new Set<string>();
  for (const s of doc.scenes) {
    if (s.voice) keys.add(s.voice.key);
    if (s.visual.kind !== "solid") keys.add(s.visual.key);
  }
  if (doc.music) keys.add(doc.music.key);
  if (doc.brand.logoSrc) keys.add(doc.brand.logoSrc);
  return [...keys];
}

type LegacyBuild = {
  buildId?: string;
  /** Phase 3 stored `words` as a count; phase 4 keeps the count there and the timed words in `doc`. */
  voice?: { scenes: Array<{ sceneId: string; durationMs: number; key?: string; words?: TimedWord[] | number; spokenText?: string }> };
  music?: { source: string; title: string; licence: string; key?: string } | null;
  stock?: Record<string, { selected?: { assetId?: string; thumbnailUrl?: string | null } | null }>;
  doc?: unknown;
};

/**
 * Document for a stored timeline version. Phase 4 builds store the document
 * itself; older versions are reconstructed from the timeline JSON: voice keys
 * follow the build layout (`media/<org>/<project>/vo/<buildId>-<scene>.wav`,
 * with the prefix taken from the mix key) and per-scene words come from the
 * captions inside each scene's time range.
 */
export function docFromTimeline(t: Timeline, build: Record<string, unknown>): EditorDoc {
  const b = build as LegacyBuild;
  if (b.doc) {
    const parsed = editorDocSchema.safeParse(b.doc);
    if (parsed.success) return parsed.data;
  }
  const voiceById = new Map((b.voice?.scenes ?? []).map((s) => [s.sceneId, s]));
  const mix = t.audio.mixSrc ?? t.audio.voiceSrc ?? "";
  const m = /^(.*\/)mix\/([^/]+?)(?:-vo)?\.wav$/.exec(mix);
  const prefix = m?.[1] ?? null;
  const buildId = b.buildId ?? m?.[2] ?? null;
  // Scene starts in ms; frame rounding can put a start up to ~17 ms after its first word, hence the slack.
  const starts = t.scenes.map((sc, i) => Math.round((sc.from / t.fps) * 1000) + (i === 0 ? LEAD_MS : 0));
  const sceneOfWord = (s: number) => {
    let idx = 0;
    for (let i = 0; i < starts.length; i++) if (starts[i] <= s + 20) idx = i;
    return idx;
  };
  const allWords = t.captions.flatMap((c) => c.words);
  const scenes: EditorScene[] = t.scenes.map((sc, i) => {
    const startMs = starts[i];
    const endMs = Math.round(((sc.from + sc.durationFrames) / t.fps) * 1000);
    const words = allWords.filter((w) => sceneOfWord(w.s) === i).map((w) => ({ w: w.w, s: Math.max(0, w.s - startMs), e: Math.max(60, w.e - startMs) }));
    const v = voiceById.get(sc.id);
    const key = sc.voiceSrc ?? v?.key ?? (prefix && buildId ? `${prefix}vo/${buildId}-${sc.id}.wav` : null);
    const last = i === t.scenes.length - 1;
    const durationMs = v?.durationMs ?? Math.max(500, endMs - startMs - (last ? TAIL_MS : GAP_MS));
    const storedWords = Array.isArray(v?.words) ? v.words : null;
    const voice = key ? { key, durationMs, words: storedWords ?? words } : null;
    const st = b.stock?.[sc.id]?.selected ?? null;
    let visual: EditorVisual;
    if (sc.visual.kind === "video") visual = { kind: "video", key: sc.visual.src, clipDurationSec: sc.visual.clipDurationSec, trimStartSec: sc.visual.trimStartSec, credit: sc.credit, assetId: st?.assetId ?? null, thumbnailUrl: st?.thumbnailUrl ?? null };
    else if (sc.visual.kind === "image") visual = { kind: "image", key: sc.visual.src, kenBurns: sc.visual.kenBurns, credit: sc.credit, assetId: null, thumbnailUrl: null };
    else visual = { kind: "solid" };
    return {
      id: sc.id,
      kind: sc.kind,
      onScreenText: sc.headline,
      voiceover: v?.spokenText ?? (voice?.words ?? []).map((w) => w.w).join(" "),
      brollTerms: [],
      durationSec: Math.round((durationMs / 1000) * 10) / 10,
      voice,
      visual,
      holdMs: 0,
      captions: null,
    };
  });
  const music = t.audio.musicSrc
    ? { key: t.audio.musicSrc, gainDb: t.audio.musicGainDb, attribution: t.attribution.find((a) => a.startsWith("Nhạc")) ?? "Nhạc", title: b.music?.title ?? "Nhạc nền", source: (b.music?.source === "mubert" ? "mubert" : "library") as "mubert" | "library", licence: b.music?.licence ?? "" }
    : null;
  return editorDocSchema.parse({ v: 1, title: t.title, language: t.language, source: t.source, brand: t.brand, scenes, music, coverAtSec: t.coverAtSec ?? null });
}

/** Human-readable diff for the version history (Vietnamese UI). */
export function describeChanges(prev: EditorDoc, next: EditorDoc): string[] {
  const out: string[] = [];
  const prevOrder = prev.scenes.map((s) => s.id).join(",");
  const nextOrder = next.scenes.map((s) => s.id).join(",");
  if (prevOrder !== nextOrder) {
    const removed = prev.scenes.filter((s) => !next.scenes.some((n) => n.id === s.id)).map((s) => s.id);
    const added = next.scenes.filter((s) => !prev.scenes.some((p) => p.id === s.id)).map((s) => s.id);
    if (removed.length) out.push(`Bỏ cảnh ${removed.join(", ")}`);
    if (added.length) out.push(`Thêm cảnh ${added.join(", ")}`);
    if (!removed.length && !added.length) out.push("Đổi thứ tự cảnh");
  }
  for (const n of next.scenes) {
    const p = prev.scenes.find((s) => s.id === n.id);
    if (!p) continue;
    if (p.onScreenText !== n.onScreenText) out.push(`${n.id}: sửa chữ trên màn hình`);
    if (JSON.stringify(p.visual) !== JSON.stringify(n.visual)) {
      if (p.visual.kind === n.visual.kind && p.visual.kind !== "solid" && n.visual.kind !== "solid" && p.visual.key === n.visual.key) {
        if (p.visual.kind === "video" && n.visual.kind === "video" && p.visual.trimStartSec !== n.visual.trimStartSec) out.push(`${n.id}: cắt clip từ ${n.visual.trimStartSec.toFixed(1)} s`);
        else out.push(`${n.id}: chỉnh hình`);
      } else out.push(`${n.id}: đổi ${n.visual.kind === "video" ? "clip" : n.visual.kind === "image" ? "ảnh" : "sang nền màu"}`);
    }
    if (p.voice?.key !== n.voice?.key) out.push(`${n.id}: giọng đọc mới`);
    else if (JSON.stringify(sceneCaptions(p)) !== JSON.stringify(sceneCaptions(n))) out.push(`${n.id}: sửa phụ đề`);
    if (p.holdMs !== n.holdMs) out.push(`${n.id}: giữ thêm ${n.holdMs} ms`);
  }
  if ((prev.music?.key ?? null) !== (next.music?.key ?? null)) out.push(next.music ? `Đổi nhạc: ${next.music.title}` : "Bỏ nhạc nền");
  else if (prev.music && next.music && prev.music.gainDb !== next.music.gainDb) out.push(`Nhạc ${next.music.gainDb} dB`);
  if ((prev.coverAtSec ?? null) !== (next.coverAtSec ?? null)) out.push(next.coverAtSec == null ? "Ảnh bìa tự động" : `Ảnh bìa tại ${next.coverAtSec.toFixed(1)} s`);
  if (prev.title !== next.title) out.push("Sửa tiêu đề");
  return out;
}

/** Move a scene within the list (dnd-kit `arrayMove` equivalent, kept here so the server can validate). */
export function moveScene(doc: EditorDoc, from: number, to: number): EditorDoc {
  const scenes = [...doc.scenes];
  const [s] = scenes.splice(from, 1);
  scenes.splice(to, 0, s);
  return { ...doc, scenes };
}

export const EDITOR_FPS = FPS;
