import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";

/**
 * Voice-over rewrites asked for in the editor (inspector "Viết gọn hơn", the
 * faithfulness check's fix "Viết lại theo bài gốc", or the editor's own words).
 * Returns a suggestion only: the editor puts it in the voice-over field and the
 * user re-voices the scene (`regenerateScene` `what: "voice"`), so nothing is
 * stored or synthesised here. The article is always given so a shorter line
 * cannot pick up facts the source does not state.
 */

import type { RewriteMode } from "./rewrite-modes";
export { REWRITE_MODES, type RewriteMode } from "./rewrite-modes";

/** Article text sent with a rewrite: enough for any news story, bounded for cost. */
const ARTICLE_MAX_CHARS = 24_000;

const OutputSchema = z.object({
  voiceover: z.string().describe("The new voice-over of this scene only, ready to be read aloud"),
  note: z.string().describe("One short sentence, in the video's language, on what changed"),
});

export type RewriteInput = {
  mode: RewriteMode;
  language: "vi" | "en";
  title: string;
  article: { text: string; siteName: string | null } | null;
  scene: { id: string; kind: "hook" | "body" | "cta"; onScreenText: string; voiceover: string; durationSec: number };
  /** Voice-over of the scenes around it, so the line still follows on. */
  before: string | null;
  after: string | null;
  /** The faithfulness pass's finding for this scene (mode `faithful`). */
  verdict: { verdict: string; note: string | null; evidence: string | null } | null;
  /** The editor's own direction (mode `custom`, optional otherwise). */
  instruction: string | null;
};

export type RewriteResult = { voiceover: string; note: string; model: string; costUsd: number };

const usageOf = (u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) => ({
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
});

function task(input: RewriteInput) {
  const words = input.scene.voiceover.trim().split(/\s+/).filter(Boolean).length;
  if (input.mode === "shorter") return `Make this scene's voice-over noticeably shorter: about ${Math.max(4, Math.round(words * 0.7))} words instead of ${words}. Keep the key fact, drop filler.`;
  if (input.mode === "faithful") {
    const v = input.verdict;
    return `A fact check found this scene ${v ? `"${v.verdict}"` : "not fully supported"} by the article${v?.note ? `: ${v.note}` : ""}${v?.evidence ? `\nClosest passage in the article: "${v.evidence}"` : ""}\nRewrite it so every claim is stated by the article; drop or soften what the article does not say. Keep about the same length.`;
  }
  return "Rewrite this scene's voice-over as the editor asks.";
}

export async function rewriteVoiceover(input: RewriteInput, ctx: Omit<LlmContext, "purpose">): Promise<RewriteResult> {
  const client = await anthropic();
  const lang = input.language === "vi" ? "Vietnamese, with correct diacritics" : "English";
  const res = await client.beta.messages.parse({
    model: MODELS.rewrite,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(OutputSchema) },
    system:
      "You edit the voice-over of short vertical news videos (Reels / TikTok / Shorts), one scene at a time. " +
      "Every statement must be supported by the article; never add a fact, figure, name, date or quote it does not contain. " +
      `Write spoken ${lang}: short sentences, natural rhythm, numbers written the way they are read. ` +
      "Keep the scene's role (a hook grabs attention, a body scene carries one fact, the closing scene invites to follow). " +
      "Return only this scene's voice-over, no stage directions.",
    messages: [
      {
        role: "user",
        content: [
          input.article ? `Article${input.article.siteName ? ` (${input.article.siteName})` : ""}:\n<article>\n${input.article.text.slice(0, ARTICLE_MAX_CHARS)}\n</article>` : "No article text is available: keep to what the current voice-over states.",
          `Video: ${input.title}`,
          input.before ? `Previous scene says: ${input.before}` : null,
          `Scene ${input.scene.id} (${input.scene.kind}, about ${input.scene.durationSec.toFixed(1)} s), on screen: "${input.scene.onScreenText}"\nCurrent voice-over: ${input.scene.voiceover}`,
          input.after ? `Next scene says: ${input.after}` : null,
          task(input),
          input.instruction ? `Editor's direction: ${input.instruction}` : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  const costUsd = await recordLlmUsage(res.model, usageOf(res.usage), { ...ctx, purpose: "voiceover_rewrite" }, { stopReason: res.stop_reason, mode: input.mode, sceneId: input.scene.id });
  if (res.stop_reason === "refusal") throw new LlmOutputError("The model declined to rewrite this scene", "refusal");
  if (res.stop_reason === "max_tokens") throw new LlmOutputError("The rewrite was cut off (max_tokens)", "max_tokens");
  const out = res.parsed_output;
  if (!out || !out.voiceover.trim()) throw new LlmOutputError("The rewrite did not match the schema", res.stop_reason);
  return { voiceover: out.voiceover.trim().slice(0, 2000), note: out.note.trim().slice(0, 300), model: res.model, costUsd };
}
