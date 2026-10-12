import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { recordUsageCost } from "@/lib/activity";
import { anthropic, LlmOutputError, MODELS, recordLlmUsage, type LlmContext } from "./client";
import { collectSources, usedSources, type ResearchSource } from "./research-sources";

/**
 * Topic projects (`projects.source_kind = "topic"`): the user typed keywords, a topic or directions instead of a link.
 * Two calls, so that structured output never meets the web tools' citations:
 * 1. research: Claude with the server-side web search + web fetch tools reads current reporting on the brief and
 *    writes notes where every fact names its page (`pause_turn` is resumed a few times);
 * 2. write: a structured pass turns the notes into the project's article (title, neutral news text, the sources it
 *    used). The article is the fact base of the script and of the faithfulness check, exactly like a fetched one.
 * Links are never taken from the model alone: `usedSources` keeps only pages the tools really returned.
 */

/** Web searches / page fetches per research turn: enough for one story, bounded for time (direct runs have 300 s). */
const MAX_SEARCHES = 6;
const MAX_FETCHES = 5;
/** `pause_turn` resumptions (the server-side tool loop stops after 10 iterations). */
const MAX_CONTINUATIONS = 3;
/** Anthropic web search: $10 per 1,000 searches, on top of tokens. Web fetch costs tokens only. */
const WEB_SEARCH_USD = 0.01;
/** Notes sent to the writing pass. */
const NOTES_MAX_CHARS = 40_000;

const ArticleSchema = z.object({
  found: z.boolean().describe("True when the notes hold enough reliable, on-topic facts for a short news video"),
  problem: z.string().describe("When found is false: one sentence, in the brief's language, saying what was missing. Empty otherwise."),
  title: z.string().describe("Headline of the story, in the article's language"),
  text: z.string().describe("The article: plain paragraphs separated by blank lines, no headings, no markdown, no links"),
  sources: z
    .array(
      z.object({
        url: z.string().describe("Exact URL from the notes"),
        outlet: z.string().describe("Publication name as readers know it, e.g. VnExpress, Reuters"),
        title: z.string().describe("Page title"),
      }),
    )
    .describe("Pages the article's facts come from, most important first"),
});

type Usage = Anthropic.Beta.BetaUsage;

const tokens = (u: Usage) => ({
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
});

const vietnamToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

const RESEARCH_SYSTEM =
  "You research topics for short vertical news videos (Facebook Reels, TikTok, YouTube Shorts) made by a Vietnamese newsroom. " +
  "The editor gives a brief: keywords, a topic, a question, or directions for the video. Find what is current and verifiable about it. " +
  "Search the web (Vietnamese and English queries as fits the topic), prefer established news outlets, official bodies and primary documents, " +
  "and open the most relevant pages with web fetch to read the details instead of relying on snippets. Favour the most recent reporting and note dates. " +
  "When the brief is broad, settle on the single most newsworthy recent angle. " +
  "Then write research notes: each fact, figure, date, name and quote on its own line followed by the exact URL it came from; " +
  "say where sources disagree; never add anything the pages do not state. " +
  "Directions in the brief about tone, angle, audience or format are for the video, not search terms: list them under a final 'Directions' heading.";

/** Step 1: the research turn with the web tools, resumed on `pause_turn`. Returns the notes and every page found. */
async function researchNotes(client: Anthropic, brief: string, ctx: Omit<LlmContext, "purpose">) {
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    // No `country`: the search provider rejects "VN" (400 "Country code VN is not supported"). The timezone alone is a valid
    // location, and the prompt already asks for Vietnamese queries.
    { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES, user_location: { type: "approximate", timezone: "Asia/Ho_Chi_Minh" } },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_FETCHES, max_content_tokens: 12_000 },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Today is ${vietnamToday()} (Vietnam).\n\nEditor's brief:\n<brief>\n${brief}\n</brief>` },
  ];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let searches = 0;
  let fetches = 0;
  let costUsd = 0;
  let model: string = MODELS.research;
  for (let turn = 0; ; turn++) {
    const res = await client.beta.messages.create({
      model: MODELS.research,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: RESEARCH_SYSTEM,
      tools,
      messages,
    });
    model = res.model;
    const s = res.usage.server_tool_use?.web_search_requests ?? 0;
    searches += s;
    fetches += res.usage.server_tool_use?.web_fetch_requests ?? 0;
    costUsd += await recordLlmUsage(res.model, tokens(res.usage), { ...ctx, purpose: "topic_research" }, { stopReason: res.stop_reason, turn, webSearches: s });
    if (s) {
      await recordUsageCost({ provider: "anthropic", resource: "web_search", units: s, unitType: "requests", costUsd: s * WEB_SEARCH_USD, ...ctx, meta: { purpose: "topic_research", turn } });
      costUsd += s * WEB_SEARCH_USD;
    }
    content.push(...res.content);
    if (res.stop_reason === "refusal") throw new LlmOutputError("The model declined to research this topic", "refusal");
    // The server-side tool loop paused: send the turn back as it is and it resumes (no extra user message).
    if (res.stop_reason === "pause_turn" && turn < MAX_CONTINUATIONS) {
      messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      continue;
    }
    break;
  }
  // The notes are the text written after the last tool call (earlier text is narration between searches).
  const lastTool = content.findLastIndex((b) => b.type === "server_tool_use" || b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result");
  const notes = content
    .slice(lastTool + 1)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const found = collectSources(content as unknown as Array<{ type: string }>);
  return { notes, found, searches, fetches, costUsd, model };
}

/** Step 2: the article, from the notes only, with the sources it used. */
async function writeArticle(client: Anthropic, brief: string, notes: string, found: readonly ResearchSource[], ctx: Omit<LlmContext, "purpose">) {
  const res = await client.beta.messages.parse({
    model: MODELS.research,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(ArticleSchema) },
    system:
      "You turn research notes into the source article of a short vertical news video. " +
      "Write in the language of the editor's brief (Vietnamese with correct diacritics, or English), unless the brief asks for the other one. " +
      "Neutral news style, 250 to 600 words: the main news first, then context, figures, consequences and what comes next. " +
      "Use only facts stated in the notes; attribute claims to their outlet in the text (for example “theo Reuters”); keep dates absolute. " +
      "Leave the brief's directions about tone or format out of the article: they are applied later, when the script is written. " +
      "If the notes are empty, off-topic or too thin for a video, set found to false and say why.",
    messages: [
      {
        role: "user",
        content: [
          `Editor's brief:\n<brief>\n${brief}\n</brief>`,
          `Research notes (${vietnamToday()}):\n<notes>\n${notes.slice(0, NOTES_MAX_CHARS) || "(no notes)"}\n</notes>`,
          found.length ? `Pages found:\n${found.map((s) => `- ${s.url}${s.title ? ` (${s.title})` : ""}`).join("\n")}` : "No pages were found.",
        ].join("\n\n"),
      },
    ],
  });
  const costUsd = await recordLlmUsage(res.model, tokens(res.usage), { ...ctx, purpose: "topic_article" }, { stopReason: res.stop_reason });
  if (res.stop_reason === "refusal") throw new LlmOutputError("The model declined to write about this topic", "refusal");
  if (res.stop_reason === "max_tokens") throw new LlmOutputError("The article was cut off (max_tokens)", "max_tokens");
  if (!res.parsed_output) throw new LlmOutputError("The article did not match the schema", res.stop_reason);
  return { out: res.parsed_output, costUsd };
}

export type ResearchNotes = Awaited<ReturnType<typeof researchNotes>>;

/**
 * Step 1 of a topic project's fetch (its own pipeline step, so each call has the route's whole time budget):
 * research the brief on the web. Throws when the web gave nothing at all.
 */
export async function researchBrief(brief: string, ctx: Omit<LlmContext, "purpose">) {
  const r = await researchNotes(await anthropic(), brief, ctx);
  if (!r.found.length) throw new LlmOutputError("The research found no web pages for this brief; try other or more specific keywords", "end_turn");
  return r;
}

/** Step 2: the project's article from the notes. Throws a readable error when the notes are not enough for a video. */
export async function writeTopicArticle(brief: string, notes: Pick<ResearchNotes, "notes" | "found">, ctx: Omit<LlmContext, "purpose">) {
  const w = await writeArticle(await anthropic(), brief, notes.notes, notes.found, ctx);
  if (!w.out.found || !w.out.text.trim()) throw new LlmOutputError(w.out.problem.trim() || "Not enough reliable information was found for this brief; try other keywords", "end_turn");
  return { title: w.out.title.trim(), text: w.out.text.trim(), sources: usedSources(w.out.sources, notes.found), costUsd: w.costUsd };
}
