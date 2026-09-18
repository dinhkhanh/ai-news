/**
 * Structured-output schemas shared by the pipeline, the UI and tests.
 * Rules for Anthropic structured outputs: every field required (use .nullable()
 * instead of .optional()), no numeric min/max constraints, enums are fine.
 */
import { z } from "zod";

export const SceneSchema = z.object({
  id: z.string().describe("Stable scene id: s1, s2, … in order"),
  kind: z.enum(["hook", "body", "cta"]),
  voiceover: z.string().describe("Voice-over text, written to be read aloud by TTS"),
  onScreenText: z.string().describe("Short caption shown on screen, max 8 words"),
  brollTerms: z.array(z.string()).describe("2-4 English stock-footage search phrases"),
  newsTerms: z
    .array(z.string())
    .describe(
      "1-3 news search queries in the article's language naming exactly what this scene's voice-over mentions – the person, organisation, company, place, product or event – so pictures of them can be found (what you hear is what you see); [] when the voice-over names nothing specific",
    ),
  durationSec: z.number().describe("Estimated seconds for this scene"),
  supportingSentence: z.string().nullable().describe("Verbatim sentence from the article that supports this scene, null for hook/CTA without facts"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const PlatformMetaSchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()).describe("Without the # prefix or with it, either is accepted"),
});

export const ScriptSchema = z.object({
  title: z.string().describe("Working title for the video"),
  scenes: z.array(SceneSchema),
  estimatedDurationSec: z.number(),
  metadata: z.object({
    youtube: PlatformMetaSchema,
    facebook: PlatformMetaSchema,
    tiktok: PlatformMetaSchema,
  }),
  sensitiveTopic: z.boolean().describe("True if the story touches elections, health, legal proceedings, minors or victims"),
  notes: z.string().nullable().describe("Limitations or reviewer notes; null if none"),
});
export type Script = z.infer<typeof ScriptSchema>;

export const SceneVerdictSchema = z.object({
  sceneId: z.string(),
  verdict: z.enum(["supported", "partial", "unsupported"]),
  evidence: z.string().nullable().describe("Verbatim sentence(s) from the article; null if none"),
  note: z.string().nullable().describe("What is unsupported and how to fix it; null when supported"),
});
export type SceneVerdict = z.infer<typeof SceneVerdictSchema>;

export const FaithfulnessSchema = z.object({
  scenes: z.array(SceneVerdictSchema),
  summary: z.string().describe("One or two sentences for the reviewer"),
});
export type Faithfulness = z.infer<typeof FaithfulnessSchema>;

export const ClassificationSchema = z.object({
  language: z.enum(["vi", "en", "other"]),
  confidence: z.number().describe("0-1"),
  isNewsArticle: z.boolean(),
  sensitiveTopic: z.boolean(),
  sensitiveCategories: z.array(z.enum(["elections", "health", "legal", "minors", "violence", "none"])),
  /** Politics in the wide sense (government, parties, officials, elections, policy, diplomacy, security): such videos use no stock or AI pictures. */
  political: z.boolean(),
  reason: z.string(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** Which of the workspace's brand kits suits an article (`pick-brand-kit.ts`). */
export const BrandKitPickSchema = z.object({
  kitId: z.string().nullable().describe("id of the best kit, exactly as listed; null when no kit clearly fits"),
  confidence: z.number().describe("0-1"),
  reason: z.string().describe("One short sentence in Vietnamese"),
});
export type BrandKitPick = z.infer<typeof BrandKitPickSchema>;

/** What is persisted in scripts.scenes_json. */
export type StoredScript = Script & {
  generation: {
    language: "vi" | "en";
    durationSec: number;
    tone: string;
    model: string;
    templateId: string | null;
    templateVersion: number;
    latencyMs: number;
    stopReason: string | null;
    servedBy: string | null;
  };
};

/** What is persisted in scripts.faithfulness_json. */
export type StoredFaithfulness = Faithfulness & {
  counts: { supported: number; partial: number; unsupported: number; unchecked: number };
  evidenceFound: Record<string, boolean>;
  model: string;
  templateId: string | null;
  templateVersion: number;
  costUsd: number;
  latencyMs: number;
};

/** Normalise model output before storing: sequential ids, trimmed strings, hashtags without #, sane durations. */
export function normaliseScript(s: Script): Script {
  const scenes = s.scenes.map((sc, i) => ({
    ...sc,
    id: `s${i + 1}`,
    voiceover: sc.voiceover.trim(),
    onScreenText: sc.onScreenText.trim(),
    brollTerms: sc.brollTerms.map((t) => t.trim()).filter(Boolean).slice(0, 6),
    newsTerms: (sc.newsTerms ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 3),
    durationSec: Math.max(1, Math.round(sc.durationSec * 10) / 10),
    supportingSentence: sc.supportingSentence?.trim() || null,
  }));
  const tag = (h: string) => h.trim().replace(/^#+/, "").replace(/\s+/g, "");
  const meta = (m: z.infer<typeof PlatformMetaSchema>) => ({
    title: m.title.trim(),
    description: m.description.trim(),
    hashtags: Array.from(new Set(m.hashtags.map(tag).filter(Boolean))),
  });
  return {
    ...s,
    title: s.title.trim(),
    scenes,
    estimatedDurationSec: Math.round(scenes.reduce((a, b) => a + b.durationSec, 0) * 10) / 10,
    metadata: { youtube: meta(s.metadata.youtube), facebook: meta(s.metadata.facebook), tiktok: meta(s.metadata.tiktok) },
    notes: s.notes?.trim() || null,
  };
}
