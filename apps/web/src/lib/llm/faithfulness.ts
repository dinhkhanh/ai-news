import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Language } from "@/lib/prompts/defaults";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";
import { buildSystem, loadTemplate, type ArticleInput, type LoadedTemplate } from "./prompt";
import { evidenceAppears } from "./evidence";
import { FaithfulnessSchema, type Script, type StoredFaithfulness } from "./schemas";

/**
 * Faithfulness pass (docs/PLAN.md §4.2): a second Opus 5 call judges every
 * scene against the article. Unsupported scenes are surfaced in the review view
 * and, in phase 5, block publishing without a publisher override.
 */
export async function checkFaithfulness(
  input: { article: ArticleInput; script: Script; language: Language; templateId?: string | null },
  ctx: Omit<LlmContext, "purpose">,
): Promise<{ result: StoredFaithfulness; template: LoadedTemplate }> {
  const template = await loadTemplate("faithfulness", input.language, input.templateId);
  const model = template.model || MODELS.faithfulness;
  const client = await anthropic();
  const system = buildSystem(template, { language: input.language, duration_sec: "", tone: "", tone_guidance: "" }, input.article);
  const scenes = input.script.scenes.map((s) => ({ id: s.id, kind: s.kind, voiceover: s.voiceover, onScreenText: s.onScreenText }));
  const ask =
    input.language === "vi"
      ? "Đánh giá từng cảnh trong kịch bản sau so với bài báo ở trên."
      : "Assess every scene of the following script against the article above.";

  const t0 = Date.now();
  const res = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(FaithfulnessSchema) },
    system,
    messages: [{ role: "user", content: `${ask}\n\n<script>\n${JSON.stringify(scenes, null, 2)}\n</script>` }],
  });
  const latencyMs = Date.now() - t0;
  const usage = {
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };
  const costUsd = await recordLlmUsage(res.model, usage, { ...ctx, purpose: "faithfulness" }, { latencyMs, templateVersion: template.version, stopReason: res.stop_reason });

  if (res.stop_reason === "refusal") throw new LlmOutputError("The model declined to run the faithfulness check", "refusal");
  if (!res.parsed_output) throw new LlmOutputError("Faithfulness output did not match the schema", res.stop_reason);

  const byId = new Map(res.parsed_output.scenes.map((s) => [s.sceneId, s]));
  const evidenceFound: Record<string, boolean> = {};
  const counts = { supported: 0, partial: 0, unsupported: 0, unchecked: 0 };
  const merged = input.script.scenes.map((s) => {
    const v = byId.get(s.id);
    if (!v) {
      counts.unchecked += 1;
      return { sceneId: s.id, verdict: "unsupported" as const, evidence: null, note: "Not assessed by the model; treat as unsupported." };
    }
    counts[v.verdict] += 1;
    evidenceFound[s.id] = evidenceAppears(input.article.text, v.evidence);
    return { ...v, evidence: v.evidence?.trim() || null, note: v.note?.trim() || null };
  });

  return {
    result: {
      scenes: merged,
      summary: res.parsed_output.summary.trim(),
      counts,
      evidenceFound,
      model: res.model,
      templateId: template.id,
      templateVersion: template.version,
      costUsd,
      latencyMs,
    },
    template,
  };
}
