import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ComicDoc } from "@ai-news/video/comic";
import { anthropic, LlmOutputError, recordLlmUsage } from "@/lib/llm/client";
import { textModel } from "./models";
import { adaptSystem, adaptUser, rewritePageUser, type AdaptInput } from "./prompts";
import { ComicScriptSchema, normaliseComicScript, type ComicScript } from "./script";
import type { Ctx } from "./service";

/**
 * The adaptation (docs/COMIC.md §4): the whole story → a structured comic script, on the model the comic picked.
 * Same conventions as the news scripts: adaptive thinking, structured output, cached system prompt, the server-side
 * refusal fallback where the model has one. Streamed, because a long comic is a long answer.
 */
async function callScript(model: string, user: string, ctx: Ctx & { comicId: string }, purpose: string) {
  const m = textModel(model);
  const client = await anthropic();
  const t0 = Date.now();
  const stream = client.beta.messages.stream({
    model: m.id,
    max_tokens: 64000,
    ...(m.serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    thinking: { type: "adaptive" },
    output_config: { effort: m.id.includes("haiku") ? "medium" : "high", format: betaZodOutputFormat(ComicScriptSchema) },
    system: [{ type: "text", text: adaptSystem(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const res = await stream.finalMessage();
  const usage = {
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };
  const latencyMs = Date.now() - t0;
  const costUsd = await recordLlmUsage(res.model, usage, { userId: ctx.userId, organizationId: ctx.organizationId, purpose }, { comicId: ctx.comicId, latencyMs, stopReason: res.stop_reason, servedBy: res.model !== m.id ? res.model : null });
  if (res.stop_reason === "refusal") {
    const d = res.stop_details as { category?: string | null; explanation?: string | null } | null;
    throw new LlmOutputError(`Mô hình từ chối chuyển thể truyện này${d?.category ? ` (${d.category})` : ""}${d?.explanation ? `: ${d.explanation}` : ""}`, "refusal");
  }
  if (res.stop_reason === "max_tokens") throw new LlmOutputError("Kịch bản bị cắt ngang (max_tokens): bớt số trang hoặc rút gọn truyện", "max_tokens");
  const parsed = (res as { parsed_output?: ComicScript | null }).parsed_output;
  if (!parsed) throw new LlmOutputError("Kịch bản không đúng cấu trúc", res.stop_reason);
  return { parsed, costUsd, model: res.model };
}

export async function adaptComic(input: AdaptInput, model: string, ctx: Ctx & { comicId: string }) {
  const { parsed, costUsd, model: served } = await callScript(model, adaptUser(input), ctx, "comic_adapt");
  const script = normaliseComicScript(parsed, input.cast.map((c) => c.id));
  if (!script.pages.length) throw new LlmOutputError("Kịch bản không có trang nào", "end_turn");
  return { script, costUsd, model: served };
}

/** "Viết lại trang này": one page again, with the author's direction, the rest of the comic as context. */
export async function rewriteComicPage(input: AdaptInput, doc: ComicDoc, pageIndex: number, instruction: string, model: string, ctx: Ctx & { comicId: string }) {
  const { parsed, costUsd } = await callScript(model, rewritePageUser(input, doc, pageIndex, instruction), ctx, "comic_rewrite_page");
  // Only the existing cast may appear: refs outside it are dropped by the normalisation.
  const script = normaliseComicScript({ ...parsed, cast: doc.cast.map((c) => ({ ref: c.ref, name: c.name, role: c.role, visual: c.visual, personality: c.personality })) }, doc.cast.map((c) => c.ref));
  const page = script.pages[0];
  if (!page) throw new LlmOutputError("Không nhận được trang viết lại", "end_turn");
  return { page, costUsd };
}
