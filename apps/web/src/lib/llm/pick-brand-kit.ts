import "server-only";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { KitCandidate } from "@/lib/media/brand-match";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";
import { BrandKitPickSchema, type BrandKitPick } from "./schemas";

const SYSTEM = `You choose the visual brand kit for a short news video made from an article. Each kit of the newsroom has an id, a name, a description of the stories it is meant for, and optional keywords.
- Pick the kit whose purpose clearly covers the article's main subject (not a passing mention).
- The kit marked "default" is the general look: answer null when no specialised kit clearly fits, so the default is used.
- kitId must be one of the listed ids, copied exactly. reason: one short sentence in Vietnamese.`;

/** One Haiku 4.5 call; the caller validates `kitId` against its list and falls back to keywords / the default kit. */
export async function pickBrandKit(input: { title: string | null; text: string; kits: KitCandidate[] }, ctx: Omit<LlmContext, "purpose">): Promise<BrandKitPick> {
  const client = await anthropic();
  const kits = input.kits.map((k) => `- id: ${k.id}${k.isDefault ? " (default)" : ""}\n  name: ${k.name}\n  for: ${k.description || "(no description)"}\n  keywords: ${k.keywords.join(", ") || "(none)"}`).join("\n");
  const body = input.text.length > 4000 ? `${input.text.slice(0, 4000)}\n…` : input.text;
  const res = await client.messages.parse({
    model: MODELS.classify,
    max_tokens: 512,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(BrandKitPickSchema) },
    messages: [{ role: "user", content: `Brand kits:\n${kits}\n\nArticle title: ${input.title ?? "(none)"}\n\n${body}` }],
  });
  await recordLlmUsage(res.model, res.usage, { ...ctx, purpose: "brand_kit_pick" });
  if (!res.parsed_output) throw new LlmOutputError("Brand kit pick did not match the schema", res.stop_reason);
  return res.parsed_output;
}
