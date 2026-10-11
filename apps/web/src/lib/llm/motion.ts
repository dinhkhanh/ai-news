import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { checkHyperframesHtml, HYPERFRAMES_COMPOSITION_ID, hyperframesOutputSchema, motionSpecSchema, normaliseMotionSpec, sanitiseHyperframesHtml, type MotionEngine, type MotionSpec } from "@ai-news/video/motion";
import { motionArea, OUTPUT, type Brand } from "@ai-news/video/schema";
import type { EditorVisual } from "@/lib/media/editor";
import { autoMotionCap, timingLine } from "@/lib/media/motion-plan";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";

/**
 * Motion graphics designed by Claude Opus 5.5 (`@ai-news/video/motion`):
 * `planMotionScenes` picks the scenes of a build that a graphic tells better
 * than a photo (`auto` mode); `designMotionShot` designs one shot from the
 * scene's voice-over and word timings, as a `MotionSpec` (engine `remotion`)
 * or a HyperFrames composition (engine `hyperframes`). Faithfulness: a
 * graphic may only show facts, figures and names the voice-over states.
 */

type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };

/** Server-side refusal fallback, as for the script (`llm/script.ts`). */
const fallback = () => ({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const });

function refusalOrCutoff(res: { stop_reason: string | null; stop_details?: unknown }, what: string) {
  if (res.stop_reason === "refusal") {
    const d = res.stop_details as { category?: string | null; explanation?: string | null } | null;
    throw new LlmOutputError(`The model declined to design ${what}${d?.category ? ` (${d.category})` : ""}${d?.explanation ? `: ${d.explanation}` : ""}`, "refusal");
  }
  if (res.stop_reason === "max_tokens") throw new LlmOutputError(`${what} was cut off (max_tokens)`, "max_tokens");
}

const usageOf = (u: Usage) => ({ input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 });

/* ------------------------------------------------------------------ plan */

const PlanSchema = z.object({
  scenes: z.array(z.object({ sceneId: z.string(), reason: z.string().describe("A few words in the video's language") })).describe("Only the scenes that should become motion graphics, in script order"),
});

export type PlanResult = { sceneIds: string[] | null; reasons: Record<string, string>; costUsd: number; error: string | null };

/**
 * `auto` mode: which scenes become motion graphics. Returns `sceneIds: null`
 * when the call failed, so the caller can use the figure heuristic
 * (`motionScenes`) instead of failing the build.
 */
export async function planMotionScenes(
  input: { language: "vi" | "en"; title: string; scenes: Array<{ id: string; kind: "hook" | "body" | "cta"; voiceover: string; onScreenText: string }> },
  ctx: Omit<LlmContext, "purpose">,
): Promise<PlanResult> {
  try {
    const client = await anthropic();
    const cap = autoMotionCap(input.scenes.length);
    const res = await client.beta.messages.parse({
      model: MODELS.motion,
      max_tokens: 4000,
      ...fallback(),
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: betaZodOutputFormat(PlanSchema) },
      system:
        "You edit short vertical news videos (Reels / TikTok / Shorts). Most scenes show real photos and footage of the story. " +
        "Some scenes are told better by a motion graphic: a striking figure or percentage, money, a ranking or comparison, dates and a sequence of events, a list of measures, a short quote, an abstract idea no photo shows. " +
        "Scenes about a specific person, place or event that real pictures show should stay pictures. The closing call-to-action stays a picture unless it states a figure. " +
        `Pick at most ${cap} of the ${input.scenes.length} scenes; pick none when nothing qualifies.`,
      messages: [
        {
          role: "user",
          content: `Video: ${input.title} (${input.language === "vi" ? "Vietnamese" : "English"})\n\n${input.scenes.map((s) => `${s.id} (${s.kind}) – on screen: "${s.onScreenText}"\nvoice-over: ${s.voiceover}`).join("\n\n")}`,
        },
      ],
    });
    const costUsd = await recordLlmUsage(res.model, usageOf(res.usage), { ...ctx, purpose: "motion_plan" }, { stopReason: res.stop_reason });
    refusalOrCutoff(res, "the motion plan");
    if (!res.parsed_output) throw new LlmOutputError("Motion plan did not match the schema", res.stop_reason);
    const picks = res.parsed_output.scenes;
    return { sceneIds: picks.map((p) => p.sceneId), reasons: Object.fromEntries(picks.map((p) => [p.sceneId, p.reason])), costUsd, error: null };
  } catch (e) {
    return { sceneIds: null, reasons: {}, costUsd: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------------------------------------------------------------- design */

export type MotionShotInput = {
  engine: MotionEngine;
  language: "vi" | "en";
  /** Story title and outlet, for context only. */
  title: string;
  sourceName: string | null;
  brand: Brand;
  scene: { id: string; kind: "hook" | "body" | "cta"; onScreenText: string; voiceover: string };
  /** The voice-over words heard during this shot, in seconds from its first frame (`shotWords`). */
  words: Array<{ w: string; at: number }>;
  durationSec: number;
  /** Which part of the scene this shot is (1-based), when the scene has several shots. */
  part: { index: number; count: number } | null;
  /** Pictures the graphic may use: R2 key + a URL Claude can look at. */
  images: Array<{ key: string; url: string }>;
  /** The editor's directions, or null for the build's automatic design. */
  instruction: string | null;
};

export type MotionShotResult = { visual: Extract<EditorVisual, { kind: "motion" | "hyperframes" }>; model: string; costUsd: number; latencyMs: number; attempts: number };

const COMMON_RULES = (lang: "vi" | "en") => `
Rules for every motion graphic:
- Faithfulness: show only facts, figures, names and dates the voice-over (or the on-screen line) states. Never invent or round a number differently, never add a source, a logo or a claim. When the voice-over has no figure, use words (kinetic type, a list, a quote, an icon), not made-up data.
- All on-screen text is in ${lang === "vi" ? "Vietnamese, with correct diacritics" : "English"}. Short lines: a title is at most 8 words; nothing reads like a paragraph.
- Burnt-in captions of the voice-over are drawn by the video below your graphic, so do not repeat the whole voice-over: show the key idea, the number, the structure.
- Sync with the speech: a word or figure appears about 0.2 s before it is spoken (word timings are given in seconds from the shot's first frame). Keep the last state on screen until the shot ends.
- Vertical 1080×1920 frame. The platform's UI covers the top 220 px, the right 180 px and the bottom 420 px; the captions sit right above that.
- Bold, legible, high contrast, generous spacing, one focal point at a time. Movement is purposeful: entrances, count-ups, bars growing, lines drawing. No flashing.`;

function remotionSystem(lang: "vi" | "en") {
  return `You are a senior motion designer for a news channel's short vertical videos. You design one shot as a JSON spec that a fixed renderer draws with the channel's brand colours.

The spec is a list of beats. Each beat replaces the previous one at its \`at\` time (seconds from the shot start; the first beat starts at 0). A beat stacks its elements vertically (align "center" or "top") and each element enters \`delay\` seconds after its beat starts, with an \`enter\` animation (fade, rise, pop, slide, type = letter by letter, wipe). Use 1 beat for a short shot, 2–3 for a long one (about one per sentence), at most 3 elements per beat.

Elements (fields not listed are null):
- kicker: \`label\` – small accent pill (topic, "BREAKING", a date). Use sparingly.
- title: \`text\` (+ \`emphasis\`: words drawn in the accent colour) – big kinetic headline, words rise one by one.
- text: \`text\` (+ \`emphasis\`) – one supporting line.
- stat: \`value\` counts up, \`prefix\` / \`suffix\` (units such as "%", " tỷ đồng", " km"), \`decimals\`, \`text\` = what the number is.
- bars: \`items\` [{label, value}] 2–6 bars growing, the first one highlighted; \`label\` = unit / what is measured; \`suffix\`, \`decimals\` for the values.
- list: \`items\` [{label, detail?}] 2–5 numbered points appearing one by one.
- quote: \`text\` = the quote (verbatim from the voice-over), \`label\` = who said it.
- timeline: \`items\` [{label = date, detail = event}] 2–5 points along a drawing line.
- compare: \`items\` exactly 2 [{label, value?, detail?}] side by side (before / after, A vs B); the second is highlighted.
- icon: \`emoji\` – one large emoji floating, as an accent next to a title or stat.
- image: \`image\` = index of a provided picture, \`text\` = caption. Only when pictures are provided.

\`mood\`: brand (the kit's colours, default), dark, light (paper, for explainers), alert (breaking / danger only). \`background\`: gradient, grid (data), dots, rays (energy, the hook), image (\`backgroundImage\` = a provided picture, dimmed).
${COMMON_RULES(lang)}`;
}

function hyperframesSystem(lang: "vi" | "en", durationSec: number, safeBottom: number) {
  return `You are a senior motion designer and creative coder for a news channel's short vertical videos. You write one shot as a HyperFrames composition (github.com/heygen-com/hyperframes): HTML + CSS + a GSAP timeline, rendered frame by frame in headless Chrome by seeking the timeline.

Exact format (return only this HTML, no <html>/<head>/<body>):
<div id="stage" data-composition-id="${HYPERFRAMES_COMPOSITION_ID}" data-width="1080" data-height="1920" data-start="0" data-duration="${durationSec.toFixed(2)}">
  <style>/* scoped to #stage; #stage { position:absolute; inset:0; overflow:hidden } */</style>
  …your elements, absolutely positioned…
  <script>
    const tl = gsap.timeline({ paused: true });
    // every animation is a tween on tl at an absolute position in seconds, e.g. tl.from("#title", { y: 60, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.2);
    window.__timelines = window.__timelines || {};
    window.__timelines["${HYPERFRAMES_COMPOSITION_ID}"] = tl;
  </script>
</div>

Technical constraints (the render fails otherwise):
- \`gsap\` is already loaded globally (3.13, core only: no plugins). Do not add <script src>, <link>, <iframe>, web fonts or any network URL.
- Everything that moves is on the paused timeline: no CSS animations or transitions, no setTimeout / setInterval / requestAnimationFrame, no Math.random or Date (use fixed values or a seeded formula). The timeline is seeked to arbitrary times, in any order.
- The timeline lasts at most ${durationSec.toFixed(2)} s; the final state holds until the end.
- Canvas 1080×1920. Put text between x 80 and 960, y 240 and ${Math.round(safeBottom)} (below that are the captions). Background art may fill the whole frame.
- Available CSS variables: --brand-primary, --brand-accent, --brand-bg, --brand-text, --brand-highlight, --font (the brand font, Be Vietnam Pro / Inter, weights 500–900; Vietnamese diacritics supported), --safe-bottom.
- Pictures: only the provided ones, as <img src="{{image:N}}"> (N = index); otherwise draw with CSS and inline SVG (charts, icons, maps as simple shapes).
- Keep it under 40 000 characters.
${COMMON_RULES(lang)}`;
}

function userContent(input: MotionShotInput) {
  const lang = input.language === "vi" ? "Vietnamese" : "English";
  const text = [
    `Story: ${input.title}${input.sourceName ? ` (${input.sourceName})` : ""} · language: ${lang}`,
    `Scene ${input.scene.id} (${input.scene.kind === "hook" ? "hook: the opening, must grab attention in the first second" : input.scene.kind === "cta" ? "closing call-to-action" : "body"})${input.part ? `, shot ${input.part.index} of ${input.part.count} (the other shots of the scene show other material)` : ""}.`,
    `On-screen line: "${input.scene.onScreenText}"`,
    `Voice-over of the whole scene: ${input.scene.voiceover}`,
    `Shot length: ${input.durationSec.toFixed(2)} s. Words heard during this shot (seconds from its first frame): ${timingLine(input.words) || "(none – the voice-over is in another shot)"}`,
    `Brand: ${input.brand.name}; primary ${input.brand.colours.primary}, accent ${input.brand.colours.accent}, background ${input.brand.colours.background}, text ${input.brand.colours.text}.`,
    input.images.length ? `Pictures you may use (index: what you see below): ${input.images.map((_, i) => i).join(", ")}.` : "No pictures: a pure graphic.",
    input.instruction ? `The editor's directions (follow them unless they break the rules): ${input.instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const blocks: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "url"; url: string } }> = [];
  input.images.forEach((im, i) => {
    blocks.push({ type: "text", text: `Picture ${i}:` });
    blocks.push({ type: "image", source: { type: "url", url: im.url } });
  });
  blocks.push({ type: "text", text });
  return blocks;
}

/** Design one motion shot. Throws `LlmOutputError` on a refusal / unusable output (HyperFrames is retried once with the problems named). */
export async function designMotionShot(input: MotionShotInput, ctx: Omit<LlmContext, "purpose">): Promise<MotionShotResult> {
  const client = await anthropic();
  const t0 = Date.now();
  let costUsd = 0;
  let model: string = MODELS.motion;
  const content = userContent(input);

  if (input.engine === "remotion") {
    const res = await client.beta.messages.parse({
      model: MODELS.motion,
      max_tokens: 16000,
      ...fallback(),
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(motionSpecSchema) },
      system: [{ type: "text", text: remotionSystem(input.language), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    model = res.model;
    costUsd += await recordLlmUsage(res.model, usageOf(res.usage), { ...ctx, purpose: "motion" }, { engine: "remotion", sceneId: input.scene.id, stopReason: res.stop_reason });
    refusalOrCutoff(res, "the motion graphic");
    if (!res.parsed_output) throw new LlmOutputError("Motion spec did not match the schema", res.stop_reason);
    const spec: MotionSpec = normaliseMotionSpec(res.parsed_output, input.durationSec);
    if (!spec.beats.length) throw new LlmOutputError("Motion spec has no beats", res.stop_reason);
    return { visual: { kind: "motion", spec, images: input.images.map((i) => i.key), instruction: input.instruction }, model, costUsd, latencyMs: Date.now() - t0, attempts: 1 };
  }

  const system = hyperframesSystem(input.language, input.durationSec, motionArea(input.brand, input.scene.kind).y1 || OUTPUT.height - 600);
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.beta.messages.parse({
      model: MODELS.motion,
      max_tokens: 16000,
      ...fallback(),
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(hyperframesOutputSchema) },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: problems.length ? [...content, { type: "text" as const, text: `A previous attempt was rejected: ${problems.join("; ")}. Fix these.` }] : content }],
    });
    model = res.model;
    costUsd += await recordLlmUsage(res.model, usageOf(res.usage), { ...ctx, purpose: "motion" }, { engine: "hyperframes", sceneId: input.scene.id, attempt, stopReason: res.stop_reason });
    refusalOrCutoff(res, "the HyperFrames composition");
    if (!res.parsed_output) throw new LlmOutputError("HyperFrames output did not match the schema", res.stop_reason);
    const html = sanitiseHyperframesHtml(res.parsed_output.html);
    problems = checkHyperframesHtml(html);
    if (!problems.length) {
      return { visual: { kind: "hyperframes", html, images: input.images.map((i) => i.key), summary: res.parsed_output.summary.slice(0, 400), instruction: input.instruction }, model, costUsd, latencyMs: Date.now() - t0, attempts: attempt };
    }
  }
  throw new LlmOutputError(`HyperFrames composition unusable: ${problems.join("; ")}`, "invalid");
}
