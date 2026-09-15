import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { anthropic, MODELS, recordLlmUsage, type LlmContext } from "@/lib/llm/client";
import type { StockCandidate } from "./stock";

const RankSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().describe("Candidate number as given"),
      score: z.number().describe("0-100 fit for this scene"),
      reason: z.string().describe("Short reason"),
      unsafe: z.boolean().describe("True if the thumbnail shows an identifiable real person as the subject, text overlays, logos, or content unsuitable for news"),
    }),
  ),
});

const SYSTEM = `You pick stock B-roll for a vertical short news video. You see the voice-over line and on-screen text of one scene, then numbered candidate thumbnails.
Score each candidate 0-100 for how well it illustrates the scene: subject match first, then vertical framing, visual clarity, neutral/news-appropriate look. Penalise thumbnails with burnt-in text, logos or watermarks, staged stock-actor close-ups, or anything that would mislead viewers about the actual story (wrong country, wrong event). Mark unsafe=true for identifiable real people as the subject or unsuitable content.`;

/** Haiku ranks candidate thumbnails for a scene (docs/PLAN.md §4.3). Returns candidates sorted by score. */
export async function rankCandidates(
  scene: { voiceover: string; onScreenText: string; brollTerms: string[] },
  candidates: StockCandidate[],
  ctx: Omit<LlmContext, "purpose">,
): Promise<{ ranked: Array<StockCandidate & { score: number; reason: string }>; costUsd: number }> {
  if (candidates.length === 0) return { ranked: [], costUsd: 0 };
  if (candidates.length === 1) return { ranked: [{ ...candidates[0], score: 50, reason: "only candidate" }], costUsd: 0 };
  const client = await anthropic();
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `Scene voice-over: ${scene.voiceover}\nOn-screen text: ${scene.onScreenText}\nSearch terms used: ${scene.brollTerms.join(", ")}\n\nCandidates:` },
  ];
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `Candidate ${i + 1} (${c.provider}, ${c.width}x${c.height}, ${c.durationSec}s, term "${c.searchTerm}")` });
    content.push({ type: "image", source: { type: "url", url: c.thumbnailUrl } });
  });
  const res = await client.messages.parse({
    model: MODELS.classify,
    max_tokens: 2048,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(RankSchema) },
    messages: [{ role: "user", content }],
  });
  const costUsd = await recordLlmUsage(res.model, res.usage, { ...ctx, purpose: "rank_broll" }, { candidates: candidates.length });
  const scores = new Map(res.parsed_output?.scores.map((s) => [s.index - 1, s]) ?? []);
  const ranked = candidates
    .map((c, i) => {
      const s = scores.get(i);
      return { ...c, score: s ? (s.unsafe ? Math.min(s.score, 10) : s.score) : 30, reason: s?.reason ?? "not scored" };
    })
    .sort((a, b) => b.score - a.score);
  return { ranked, costUsd };
}
