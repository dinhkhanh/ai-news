import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ComicDoc, Panel } from "@ai-news/video/comic";
import { anthropic, LlmOutputError, recordLlmUsage } from "@/lib/llm/client";
import { textModel } from "./models";
import { shortenUser } from "./prompts";
import type { Ctx } from "./service";

/**
 * "Rút gọn lời thoại" (docs/COMIC.md §9): the lines of a panel that do not fit their balloons, shorter, on the comic's
 * text model. Only the lines asked for change; the meaning, the speaker's voice and the language stay.
 */

const OutputSchema = z.object({
  lines: z.array(z.object({ id: z.string().describe("The id of the line, as given"), text: z.string().describe("The shorter line, in the comic's language") })),
});

export async function shortenLines(doc: ComicDoc, panel: Panel, ids: string[], model: string, ctx: Ctx & { comicId: string }) {
  const m = textModel(model);
  const client = await anthropic();
  const res = await client.beta.messages.parse({
    model: m.id,
    max_tokens: 4000,
    ...(m.serverFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: betaZodOutputFormat(OutputSchema) },
    system:
      "You letter comics. Make the given balloon lines shorter while keeping what they say, who says it and how that character talks. " +
      "Keep the language of each line. Return every line you were asked to shorten, with its id; never add facts.",
    messages: [{ role: "user", content: shortenUser(doc, panel, ids) }],
  });
  const usage = {
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };
  const costUsd = await recordLlmUsage(res.model, usage, { userId: ctx.userId, organizationId: ctx.organizationId, purpose: "comic_shorten" }, { comicId: ctx.comicId, panelId: panel.id });
  if (res.stop_reason === "refusal") throw new LlmOutputError("Mô hình từ chối sửa lời thoại này", "refusal");
  const parsed = res.parsed_output;
  if (!parsed) throw new LlmOutputError("Không nhận được lời thoại rút gọn", res.stop_reason);
  const texts = Object.fromEntries(parsed.lines.filter((l) => ids.includes(l.id) && l.text.trim()).map((l) => [l.id, l.text.trim().slice(0, 300)]));
  return { texts, costUsd };
}
