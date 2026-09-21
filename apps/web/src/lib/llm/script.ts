import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { toneGuidance, toneLabel, type Language } from "@/lib/prompts/defaults";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";
import { buildSystem, loadTemplate, type ArticleInput, type LoadedTemplate } from "./prompt";
import { normaliseScript, ScriptSchema, type StoredScript } from "./schemas";

export type GenerateScriptInput = {
  article: ArticleInput;
  language: Language;
  durationSec: number;
  tone: string;
  /** Pin a specific template version (eval runs); default = promoted or built-in. */
  templateId?: string | null;
};

export type GenerateScriptResult = {
  script: StoredScript;
  template: LoadedTemplate;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  costUsd: number;
  latencyMs: number;
};

/**
 * Not every project is a news article: a `video` project's text is what the user wrote about a video (the facts to
 * tell, possibly with directions for the script), and its footage is that video; a `text` project is the user's
 * own writing. Kept in the user message so the cached system prefix stays the template + text.
 */
function sourceNote(kind: GenerateScriptInput["article"]["kind"], lang: Language) {
  if (kind === "video") {
    return lang === "vi"
      ? " Lưu ý: nguồn là một video (trang ghi ở Source), không phải bài báo. Văn bản ở trên do biên tập viên viết về video đó: đó là toàn bộ dữ kiện được dùng, và nếu có chỉ dẫn cách viết kịch bản thì làm theo chỉ dẫn, đừng đọc chỉ dẫn thành lời bình. Hình ảnh của mọi cảnh là chính video này, nên lời bình kể và bình luận về nội dung video; không bịa chi tiết ngoài văn bản."
      : " Note: the source is a video (the page under Source), not a news article. The text above was written by the editor about that video: it is all the facts there are, and any directions it gives for the script are to be followed, never read out as voice-over. Every scene's picture is this video itself, so the voice-over tells and comments on what the video shows; invent nothing beyond the text.";
  }
  if (kind === "text") {
    return lang === "vi"
      ? " Lưu ý: văn bản ở trên do biên tập viên tự viết (không có link bài báo); nếu có chỉ dẫn cách viết kịch bản thì làm theo, đừng đọc chỉ dẫn thành lời bình."
      : " Note: the text above was written by the editor (there is no article link); follow any directions it gives for the script, never read them out as voice-over.";
  }
  return "";
}

function userMessage(input: GenerateScriptInput) {
  const lang = input.language;
  const tone = toneLabel(input.tone, lang);
  const note = sourceNote(input.article.kind, lang);
  return lang === "vi"
    ? `Viết kịch bản từ ${input.article.kind === "video" ? "nội dung" : "bài báo"} ở trên. Thời lượng mục tiêu: ${input.durationSec} giây. Giọng điệu: ${tone}. Ngôn ngữ đầu ra: tiếng Việt.${note}`
    : `Write the script from the ${input.article.kind === "video" ? "content" : "article"} above. Target length: ${input.durationSec} seconds. Tone: ${tone}. Output language: English.${note}`;
}

/**
 * Script generation (docs/PLAN.md §4.2): Claude Opus 5, adaptive thinking,
 * structured output, cached system prefix (template + article), server-side
 * refusal fallback so a policy decline on the primary model still yields a script.
 */
export async function generateScript(input: GenerateScriptInput, ctx: Omit<LlmContext, "purpose">): Promise<GenerateScriptResult> {
  const template = await loadTemplate("script", input.language, input.templateId);
  const model = template.model || MODELS.script;
  const client = await anthropic();
  const system = buildSystem(
    template,
    { language: input.language, duration_sec: input.durationSec, tone: toneLabel(input.tone, input.language), tone_guidance: toneGuidance(input.tone, input.language) },
    input.article,
  );
  const t0 = Date.now();
  const res = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(ScriptSchema) },
    system,
    messages: [{ role: "user", content: userMessage(input) }],
  });
  const latencyMs = Date.now() - t0;
  const usage = {
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };
  const servedBy = res.model !== model ? res.model : null;
  const costUsd = await recordLlmUsage(res.model, usage, { ...ctx, purpose: "script" }, { latencyMs, templateVersion: template.version, stopReason: res.stop_reason, servedBy });

  if (res.stop_reason === "refusal") {
    const d = res.stop_details as { category?: string | null; explanation?: string | null } | null;
    throw new LlmOutputError(`The model declined to write this script${d?.category ? ` (${d.category})` : ""}${d?.explanation ? `: ${d.explanation}` : ""}`, "refusal");
  }
  if (res.stop_reason === "max_tokens") throw new LlmOutputError("Script output was cut off (max_tokens)", "max_tokens");
  if (!res.parsed_output) throw new LlmOutputError("Script output did not match the schema", res.stop_reason);

  const script = normaliseScript(res.parsed_output);
  if (script.scenes.length < 2) throw new LlmOutputError("Script has fewer than two scenes", res.stop_reason);

  return {
    script: {
      ...script,
      generation: {
        language: input.language,
        durationSec: input.durationSec,
        tone: input.tone,
        model: res.model,
        templateId: template.id,
        templateVersion: template.version,
        latencyMs,
        stopReason: res.stop_reason,
        servedBy,
      },
    },
    template,
    model: res.model,
    usage,
    costUsd,
    latencyMs,
  };
}
