import "server-only";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";
import { ClassificationSchema, type Classification } from "./schemas";


const SYSTEM = `You classify news articles for a Vietnamese newsroom's video pipeline. Answer with the structured fields only.
- language: the language the article body is written in ("vi" Vietnamese, "en" English, otherwise "other").
- isNewsArticle: false for listings, home pages, error/consent pages, pure video pages or content that is not a news story.
- sensitiveTopic: true when the story concerns elections or politics of candidates, health/medical claims, court cases or criminal accusations, minors, or violence with identifiable victims. Such stories are routed to a publisher for review.
- sensitiveCategories: the matching categories, or ["none"].
- reason: one short sentence.`;

/** Language detection + sensitive-topic flag in one Haiku 4.5 call (docs/PLAN.md §2, §8). */
export async function classifyArticle(input: { title: string | null; text: string }, ctx: Omit<LlmContext, "purpose">): Promise<Classification> {
  const client = await anthropic();
  const body = input.text.length > 6000 ? `${input.text.slice(0, 6000)}\n…` : input.text;
  const res = await client.messages.parse({
    model: MODELS.classify,
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ClassificationSchema) },
    messages: [{ role: "user", content: `Title: ${input.title ?? "(none)"}\n\n${body}` }],
  });
  await recordLlmUsage(res.model, res.usage, { ...ctx, purpose: "classify" });
  if (!res.parsed_output) throw new LlmOutputError("Classification output did not match the schema", res.stop_reason);
  return res.parsed_output;
}
