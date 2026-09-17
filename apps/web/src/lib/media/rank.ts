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

const AssignSchema = z.object({
  scenes: z.array(
    z.object({
      sceneId: z.string(),
      /** Candidate numbers as given, best first; may be shorter than `want`. */
      picks: z.array(z.number()),
    }),
  ),
});

const ASSIGN_SYSTEM = `You place pictures into the scenes of a vertical short news video. You see every scene (voice-over + on-screen text, and how many pictures it needs) and numbered candidates: images from the source article, images from other outlets' coverage of the same story, and web videos about the story (shown by their thumbnail, with title, channel and length; a video listed for a scene fills as many consecutive shots of that scene as its hint says).
For each scene list the candidate numbers that best illustrate it, best first, up to the number it needs. Prefer candidates whose subject matches the scene's facts (place, people, object, event). When two candidates fit equally, prefer the one from the source article; other outlets' images and web videos rank equally after it (each candidate says where it comes from). Only pick a web video whose title is clearly about this same story, not a similar or older event. Never list the same candidate for two scenes. Skip candidates with burnt-in text, logos, watermarks, or that would mislead about the story. A scene may get fewer picks than it needs, or none, if nothing fits.`;

export type ImageCandidate = { key: string; thumbnailUrl: string; hint?: string | null };

/**
 * One Haiku call assigns article / related images and web-video candidates
 * (by thumbnail) to scenes, each at most once. Candidates are listed in
 * `visual-plan.ts` order and the model is told to prefer the source article.
 * Returns, per scene, candidate indexes best first. Falls back to [] on any
 * failure so the caller can assign sequentially.
 */
export async function assignImages(
  scenes: Array<{ id: string; voiceover: string; onScreenText: string; want: number }>,
  candidates: ImageCandidate[],
  ctx: Omit<LlmContext, "purpose">,
): Promise<{ picks: Map<string, number[]>; costUsd: number }> {
  const picks = new Map<string, number[]>();
  if (candidates.length === 0 || scenes.length === 0) return { picks, costUsd: 0 };
  const client = await anthropic();
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `Scenes:\n${scenes.map((s) => `- ${s.id} (needs ${s.want}): VO "${s.voiceover}" / on-screen "${s.onScreenText}"`).join("\n")}\n\nCandidates:` },
  ];
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `Candidate ${i + 1}${c.hint ? ` (${c.hint.slice(0, 120)})` : ""}` });
    content.push({ type: "image", source: { type: "url", url: c.thumbnailUrl } });
  });
  const res = await client.messages.parse({
    model: MODELS.classify,
    max_tokens: 2048,
    system: ASSIGN_SYSTEM,
    output_config: { format: zodOutputFormat(AssignSchema) },
    messages: [{ role: "user", content }],
  });
  const costUsd = await recordLlmUsage(res.model, res.usage, { ...ctx, purpose: "assign_images" }, { candidates: candidates.length, scenes: scenes.length });
  const used = new Set<number>();
  for (const s of res.parsed_output?.scenes ?? []) {
    const idx = s.picks.map((n) => n - 1).filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length && !used.has(i));
    for (const i of idx) used.add(i);
    picks.set(s.sceneId, idx);
  }
  return { picks, costUsd };
}
