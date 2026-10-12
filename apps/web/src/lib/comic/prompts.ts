import type { CastMember, ComicDoc, Panel, Setting } from "@ai-news/video/comic";
import { SCRIPT_LIMITS } from "./script";

/**
 * Prompts of the comic studio (docs/COMIC.md §4, §6). Pure and tested. The style and character blocks are built the
 * same way for every panel, byte for byte, which is what keeps a cast recognisable from panel to panel; reference
 * images (character sheets, the setting's first panel, the style's samples, the previous panel) do the rest.
 */

/** What a comic keeps of its style (`comics.style_snapshot`): editing the style later does not change a comic. */
export type ComicStyle = {
  id: string | null;
  name: string;
  /** English art direction: medium, line, colour, shading, era. */
  prompt: string;
  /** Things to avoid. */
  negative: string;
  colourMode: "colour" | "bw";
  /** How this style tells a story (pacing, silent panels, reaction shots), for the adaptation. */
  storytellingNotes: string;
  referenceKeys: string[];
};

export type AdaptInput = {
  story: string;
  language: "vi" | "en";
  /** null = automatic (5–10 from the story's length). */
  pages: number | null;
  audience: "kids" | "general" | "adult";
  dialogue: "low" | "medium" | "high";
  /** Free adaptation: scenes and lines that are not in the story are allowed. */
  free: boolean;
  readingDirection: "ltr" | "rtl";
  style: Pick<ComicStyle, "name" | "storytellingNotes" | "colourMode">;
  /** Library characters the member put in the cast. */
  cast: { id: string; name: string; role: string; visual: string; personality: string }[];
  /** Optional title the member typed. */
  title: string | null;
};

const AUDIENCE = { kids: "children (6–11): gentle, clear, no violence or fear beyond a fairy tale", general: "a general audience", adult: "adults: mature themes allowed, nothing graphic" } as const;
const DIALOGUE = { low: "little dialogue: let pictures tell most of it, many silent panels", medium: "a natural amount of dialogue", high: "dialogue-driven: most panels have lines" } as const;

/** Stable system prompt (cached): the craft rules. Story-specific input goes in the user message. */
export function adaptSystem() {
  return [
    "You adapt prose stories into comic scripts for an illustrator and a letterer.",
    "Output the whole comic as structured data: cast, recurring settings, then pages, each with its panels.",
    "Craft rules:",
    "- Page 1 establishes the setting and the protagonist; the last panel lands the ending.",
    "- 3 to 6 panels per page unless the style's notes say otherwise; vary sizes and shots; use a large or wide panel for big moments.",
    `- At most ${SCRIPT_LIMITS.maxBalloonsPerPanel} lettering items per panel and ${SCRIPT_LIMITS.maxBalloonWords} words per item. Captions narrate, speech is spoken, thought is unspoken, shout is loud, whisper is quiet, sfx is a sound word drawn in the art.`,
    "- Lettering is written in the comic's language and reads naturally aloud; descriptions, visuals and actions are written in English for the illustrator.",
    "- A panel's description says exactly what is visible: who, where, doing what, from which angle, lighting. Never ask for text, letters, signs, labels, speech bubbles or captions inside the picture: lettering is added later.",
    "- Every character in a panel must be in the cast; give each cast member a precise, stable visual description (age, build, face, hair, clothing with colours, a distinctive item) so the illustrator can draw them the same way in every panel.",
    "- Never base a character's look on a real person, a celebrity or a copyrighted character; never name artists or franchises.",
    "- Keep the story's facts and order; condense rather than drop the ending when the page count is tight.",
  ].join("\n");
}

export function adaptUser(input: AdaptInput) {
  const lang = input.language === "vi" ? "Vietnamese" : "English";
  const pages = input.pages ? `exactly ${input.pages} pages` : "5 to 10 pages, chosen from the story's length";
  const cast = input.cast.length
    ? input.cast.map((c) => `- id "${c.id}": ${c.name} (${c.role || "role not given"}). Looks: ${c.visual || "not given, describe them"}. Personality: ${c.personality || "not given"}.`).join("\n")
    : "(none chosen: create the cast from the story)";
  return [
    `<story>\n${input.story.trim()}\n</story>`,
    "",
    `Comic language: ${lang}.${input.title ? ` Title chosen by the author: "${input.title}".` : " Propose a title."}`,
    `Length: ${pages}.`,
    `Audience: ${AUDIENCE[input.audience]}.`,
    `Dialogue: ${DIALOGUE[input.dialogue]}.`,
    `Reading direction: ${input.readingDirection === "rtl" ? "right to left (manga)" : "left to right"}.`,
    `Art style: ${input.style.name} (${input.style.colourMode === "bw" ? "black and white" : "colour"}).${input.style.storytellingNotes ? ` Storytelling notes for this style: ${input.style.storytellingNotes}` : ""}`,
    input.free
      ? "Adaptation: free. You may add connecting scenes and new lines that fit the story."
      : "Adaptation: faithful. Use only events, characters and lines the story contains; you may turn narration into dialogue the characters would plausibly say about those events.",
    "",
    "Cast chosen by the author (reuse these ids as refs; add anyone else the story needs with a new short slug):",
    cast,
  ].join("\n");
}

/** User message for re-writing one page of an existing script. */
export function rewritePageUser(input: AdaptInput, doc: ComicDoc, pageIndex: number, instruction: string) {
  const outline = doc.pages
    .map((p, i) => `Page ${i + 1}${i === pageIndex ? " (TO REWRITE)" : ""}: ${p.beat}\n${p.panels.map((k, j) => `  ${j + 1}. ${k.script.description}${k.lettering.length ? ` | ${k.lettering.map((b) => `${b.kind}${b.speaker ? `(${b.speaker})` : ""}: ${b.text}`).join(" / ")}` : ""}`).join("\n")}`)
    .join("\n");
  const cast = doc.cast.map((c) => `- ref "${c.ref}": ${c.name}, ${c.role}. ${c.visual}`).join("\n");
  return [
    adaptUser({ ...input, cast: [] }),
    "",
    "The comic already exists. Its cast (use exactly these refs):",
    cast,
    "",
    "Current script:",
    outline,
    "",
    `Rewrite page ${pageIndex + 1} only, following this direction from the author: "${instruction.trim() || "make it better"}".`,
    "Return the full structure with the same title, cast and settings, and a single page in `pages`: the rewritten one.",
  ].join("\n");
}

const styleBlock = (s: ComicStyle) =>
  [`Art style: ${s.prompt.trim()}`, s.colourMode === "bw" ? "Black and white only, no colour." : "", s.negative.trim() ? `Avoid: ${s.negative.trim()}.` : ""].filter(Boolean).join(" ");

const characterBlock = (c: CastMember) => `${c.name}: ${c.visual.trim()}`;

const HARD_RULES =
  "Strictly no text of any kind in the image: no letters, words, numbers, signs, captions, speech bubbles, sound effects, signatures, logos or watermarks. Leave some calm space near the top of the frame. A single panel of a comic, full bleed, no border, no page layout.";

/** Image prompt of one panel. */
export function panelPrompt(doc: ComicDoc, panel: Panel, style: ComicStyle, opts: { aspect: string; refsNote: string | null; instruction?: string | null }) {
  const inPanel = panel.script.characters.map((c) => ({ c, m: doc.cast.find((x) => x.ref === c.ref) })).filter((x) => x.m);
  const setting: Setting | undefined = doc.settings.find((s) => s.id === panel.script.settingId);
  return [
    styleBlock(style),
    inPanel.length ? `Characters (keep each exactly as described${opts.refsNote ? " and as in the reference sheets" : ""}):\n${inPanel.map((x) => `- ${characterBlock(x.m!)}`).join("\n")}` : "",
    setting ? `Setting: ${setting.name}: ${setting.visual}` : "",
    `Shot: ${panel.script.shot}, ${opts.aspect} frame. Time: ${panel.script.time || "unspecified"}. Mood: ${panel.script.mood || "neutral"}.`,
    `Scene: ${panel.script.description}`,
    inPanel.length ? `Staging: ${inPanel.map((x) => `${x.m!.name} ${x.c.position === "background" ? "in the background" : `on the ${x.c.position}`}, ${x.c.action}, ${x.c.expression}`).join("; ")}.` : "",
    opts.refsNote ?? "",
    opts.instruction?.trim() ? `Direction for this drawing: ${opts.instruction.trim()}` : "",
    HARD_RULES,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What the quality gate (docs/COMIC.md §6) checks a drawn panel against: the panel's script and the characters in it,
 * whose reference sheets come with it in the same order. Problems come back as short directions for a redraw.
 */
export function qualityBrief(doc: ComicDoc, panel: Panel, sheetNames: string[]) {
  const inPanel = panel.script.characters.map((c) => ({ c, m: doc.cast.find((x) => x.ref === c.ref) })).filter((x) => x.m);
  const setting = doc.settings.find((s) => s.id === panel.script.settingId);
  return [
    sheetNames.length ? `Reference sheets above, in order: ${sheetNames.join(", ")}. The last picture is the panel to check.` : "The picture above is the panel to check.",
    `Scene: ${panel.script.description}`,
    `Shot: ${panel.script.shot}.${setting ? ` Setting: ${setting.name}: ${setting.visual}` : ""}`,
    inPanel.length
      ? `Characters who must appear (${inPanel.length}):\n${inPanel.map((x) => `- ${characterBlock(x.m!)}. Here: ${x.c.position === "background" ? "in the background" : `on the ${x.c.position}`}, ${x.c.action}, ${x.c.expression}`).join("\n")}`
      : "No named character has to appear.",
    "Report only problems a reader would notice: a character missing, extra or not matching their sheet or description (hair, face, clothes, colours, age), broken anatomy (extra or missing limbs or fingers, merged bodies, distorted faces), any text, letters, speech bubbles or watermark drawn in the picture, or the scene's main action not shown.",
    "Ignore small style differences, framing choices and details the script does not mention. Each problem is one short English direction for the artist, such as \"Give Lan her red scarf as on her sheet\".",
  ].join("\n");
}

/** Image prompt of a character sheet: turnaround + expressions on a plain background, in the comic's style. */
export function sheetPrompt(member: Pick<CastMember, "name" | "visual">, style: ComicStyle, instruction?: string | null) {
  return [
    styleBlock(style),
    `Character model sheet of ${member.name}: ${member.visual.trim()}`,
    "Layout: the same character shown full body from the front, three-quarter view and side profile, plus a row of four head close-ups (neutral, happy, sad, surprised). Plain light background, even lighting, consistent proportions and clothing in every view.",
    instruction?.trim() ? `Direction: ${instruction.trim()}` : "",
    "Strictly no text, names, labels, arrows or watermarks.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Image prompt of a style sample ("Vẽ thử"): a fixed test scene, so styles can be compared side by side. */
export function stylePreviewPrompt(style: ComicStyle) {
  return [
    styleBlock(style),
    "Scene: a girl of about ten and her grandmother sit on a wooden step in front of an old house at dusk, sharing a paper lantern; a cat sleeps beside them. Medium shot, 3:4 frame.",
    HARD_RULES,
  ].join("\n");
}

/**
 * Reference images of a panel. `base` is the panel's current picture when it is redrawn "keeping the composition":
 * it goes first and the prompt asks for the same framing with only the requested change.
 */
export type RefCandidates = { base?: string | null; sheets: string[]; setting: string | null; style: string[]; previous: string | null };

/**
 * Which reference images go with a panel, most important first, cut to the model's limit: the sheets of the
 * characters in it, then the first picture of its setting, then the style's samples, then the previous panel.
 */
export function pickRefs(c: RefCandidates, maxRefs: number): string[] {
  const ordered = [...(c.base ? [c.base] : []), ...c.sheets, ...(c.setting ? [c.setting] : []), ...c.style, ...(c.previous ? [c.previous] : [])];
  return [...new Set(ordered)].slice(0, Math.max(0, maxRefs));
}

/** Says in the prompt what each reference image is, in the order they are sent. */
export function refsNote(c: RefCandidates, picked: string[]) {
  if (!picked.length) return null;
  const label = (k: string) => (k === c.base ? "the current drawing of this panel (keep its composition, camera, poses and colours; change only what the direction asks)" : c.sheets.includes(k) ? "a character reference sheet" : k === c.setting ? "an earlier panel of the same place (keep the place, light and props consistent)" : c.style.includes(k) ? "a style sample (match its technique, not its content)" : "the previous panel (keep continuity)");
  return `Reference images, in order: ${picked.map((k, i) => `${i + 1}) ${label(k)}`).join("; ")}.`;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** "Rút gọn lời thoại": the panel, who speaks, and the lines to shorten with a word budget each. */
export function shortenUser(doc: ComicDoc, panel: Panel, ids: string[]) {
  const name = (ref: string | null) => (ref ? (doc.cast.find((c) => c.ref === ref)?.name ?? ref) : null);
  const lines = panel.lettering.filter((b) => ids.includes(b.id));
  return [
    `Comic: "${doc.title}". Language of the lines: ${doc.language === "vi" ? "Vietnamese, with correct diacritics" : "English"}.`,
    `What the panel shows: ${panel.script.description}`,
    "All lines of the panel, in reading order:",
    ...panel.lettering.map((b) => `- [${b.id}] ${b.kind}${name(b.speaker) ? ` (${name(b.speaker)})` : ""}: ${b.text}`),
    "",
    "Shorten these lines so they fit their balloons:",
    ...lines.map((b) => `- [${b.id}] at most ${Math.max(2, Math.floor(words(b.text) * 0.6))} words`),
  ].join("\n");
}
