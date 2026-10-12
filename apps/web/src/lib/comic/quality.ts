import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ComicDoc, Panel } from "@ai-news/video/comic";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage } from "@/lib/llm/client";
import { presignGet } from "@/lib/r2";
import { qualityBrief } from "./prompts";
import type { Ctx } from "./service";

/**
 * Quality gate (docs/COMIC.md §6, M3, a per-comic option, off by default): Claude looks at a drawn panel next to the
 * sheets of its characters and the panel's script and answers `{ ok, problems[] }`. The drawing job redraws a failed
 * panel once with the problems as directions. About $0.01–0.02 per panel.
 */

const OutputSchema = z.object({
  ok: z.boolean().describe("true when the panel has no problem a reader would notice"),
  problems: z.array(z.string()).describe("Short English directions for the artist, one per problem; empty when ok"),
});

export type PanelCheck = { ok: boolean; problems: string[]; costUsd: number };

export async function checkPanel(ctx: Ctx & { comicId: string }, doc: ComicDoc, panel: Panel, imageKey: string, sheets: { name: string; key: string }[]): Promise<PanelCheck> {
  const client = await anthropic();
  const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "url"; url: string } }> = [];
  for (const s of sheets) {
    content.push({ type: "text", text: `Sheet: ${s.name}` });
    content.push({ type: "image", source: { type: "url", url: await presignGet(s.key) } });
  }
  content.push({ type: "text", text: "Panel:" });
  content.push({ type: "image", source: { type: "url", url: await presignGet(imageKey) } });
  content.push({ type: "text", text: qualityBrief(doc, panel, sheets.map((s) => s.name)) });
  const res = await client.beta.messages.parse({
    model: MODELS.comicCheck,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: betaZodOutputFormat(OutputSchema) },
    system: "You are the art editor of a comic. You check one drawn panel against its script and its characters' reference sheets and report only clear problems; a good panel passes.",
    messages: [{ role: "user", content }],
  });
  const usage = {
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };
  const costUsd = await recordLlmUsage(res.model, usage, { userId: ctx.userId, organizationId: ctx.organizationId, purpose: "comic_quality" }, { comicId: ctx.comicId, panelId: panel.id, sheets: sheets.length });
  if (res.stop_reason === "refusal") throw new LlmOutputError("Mô hình từ chối kiểm tra khung này", "refusal");
  const parsed = res.parsed_output;
  if (!parsed) throw new LlmOutputError("Không nhận được kết quả kiểm tra", res.stop_reason);
  const problems = parsed.problems.map((p) => p.trim()).filter(Boolean).slice(0, 6).map((p) => p.slice(0, 200));
  return { ok: parsed.ok || problems.length === 0, problems: parsed.ok ? [] : problems, costUsd };
}
