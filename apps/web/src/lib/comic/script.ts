import { z } from "zod";
import { CHARACTER_POSITIONS, LETTERING_KINDS, PAGE_LAYOUTS, PANEL_SIZES, SHOTS } from "@ai-news/video/comic";

/**
 * Structured output of the adaptation (docs/COMIC.md §4) and its normalisation. Pure and tested.
 * Anthropic structured-output rules: every field required (nullable instead of optional), no numeric limits.
 */

export const ComicScriptSchema = z.object({
  title: z.string().describe("Title of the comic, in the comic's language"),
  logline: z.string().describe("One sentence: what the story is about, in the comic's language"),
  cast: z
    .array(
      z.object({
        ref: z.string().describe("The id given for a known character, or a new short lowercase slug for a character you add"),
        name: z.string(),
        role: z.string().describe("Short role in the story, in the comic's language"),
        visual: z.string().describe("English appearance for the illustrator: age, build, face, hair, clothes, colours, distinctive props. No names of real people or franchises"),
        personality: z.string().describe("How they behave and speak, in the comic's language"),
      }),
    )
    .describe("Every character who appears in a panel"),
  settings: z
    .array(z.object({ id: z.string().describe("Short slug"), name: z.string(), visual: z.string().describe("English description of the place for the illustrator") }))
    .describe("Recurring places"),
  pages: z.array(
    z.object({
      beat: z.string().describe("What this page does for the story, one sentence in the comic's language"),
      layout: z.enum(PAGE_LAYOUTS).describe("splash = one big panel; wide-top = an establishing panel across the top; tall-left = one tall panel on the left; grid = even rows; auto = let the panels' sizes decide"),
      panels: z.array(
        z.object({
          size: z.enum(PANEL_SIZES),
          shot: z.enum(SHOTS),
          settingId: z.string().nullable(),
          time: z.string().describe("e.g. day, night, dusk"),
          mood: z.string().describe("A few English words"),
          characters: z.array(
            z.object({
              ref: z.string(),
              position: z.enum(CHARACTER_POSITIONS).describe("Where they stand in the picture"),
              action: z.string().describe("English"),
              expression: z.string().describe("English"),
            }),
          ),
          description: z.string().describe("English: exactly what the picture shows. Never any text, letters, signs, speech bubbles or captions in the picture"),
          lettering: z.array(
            z.object({
              kind: z.enum(LETTERING_KINDS),
              speaker: z.string().nullable().describe("Cast ref for speech / thought / shout / whisper; null for caption and sfx"),
              text: z.string().describe("In the comic's language, at most 25 words"),
            }),
          ),
        }),
      ),
    }),
  ),
});
export type ComicScript = z.infer<typeof ComicScriptSchema>;

/** A story is sent whole to the adaptation (docs/COMIC.md §4); the cap keeps the cost bounded. */
export const STORY_LIMITS = { min: 80, max: 40_000 } as const;

/** Limits the adaptation is asked to keep; normalisation enforces the hard ones. */
export const SCRIPT_LIMITS = { maxPages: 40, maxPanelsPerPage: 8, maxBalloonsPerPanel: 3, maxBalloonWords: 25 } as const;

export function slug(s: string) {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "nv"
  );
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Normalises the model's script against the cast the member chose: a cast ref that is a known character id keeps
 * it; any other ref becomes `new:<slug>` (a character the adaptation proposes). Panel characters and speakers that
 * name nobody in the cast are dropped, empty lettering is removed, the hard limits are enforced.
 */
export function normaliseComicScript(raw: ComicScript, knownIds: string[]): ComicScript {
  const known = new Set(knownIds);
  const refMap = new Map<string, string>();
  const cast: ComicScript["cast"] = [];
  for (const c of raw.cast) {
    const original = clean(c.ref) || slug(c.name);
    const ref = known.has(original) ? original : `new:${slug(original.replace(/^new:/, "")) || slug(c.name)}`;
    if (refMap.has(original) || cast.some((x) => x.ref === ref)) {
      refMap.set(original, ref);
      continue;
    }
    refMap.set(original, ref);
    cast.push({ ref, name: clean(c.name) || ref, role: clean(c.role), visual: clean(c.visual), personality: clean(c.personality) });
  }
  const settings = raw.settings.filter((s, i, all) => s.id && all.findIndex((x) => x.id === s.id) === i).map((s) => ({ id: clean(s.id), name: clean(s.name), visual: clean(s.visual) }));
  const settingIds = new Set(settings.map((s) => s.id));
  const castRefs = new Set(cast.map((c) => c.ref));
  const mapRef = (r: string | null) => (r ? (refMap.get(clean(r)) ?? (castRefs.has(clean(r)) ? clean(r) : null)) : null);

  const pages = raw.pages.slice(0, SCRIPT_LIMITS.maxPages).map((p) => ({
    beat: clean(p.beat),
    layout: p.layout,
    panels: p.panels.slice(0, SCRIPT_LIMITS.maxPanelsPerPage).map((k) => ({
      ...k,
      settingId: k.settingId && settingIds.has(k.settingId) ? k.settingId : null,
      time: clean(k.time),
      mood: clean(k.mood),
      description: clean(k.description),
      characters: k.characters.flatMap((c) => {
        const ref = mapRef(c.ref);
        return ref ? [{ ...c, ref, action: clean(c.action), expression: clean(c.expression) }] : [];
      }),
      lettering: k.lettering
        .map((l) => ({ kind: l.kind, speaker: l.kind === "caption" || l.kind === "sfx" ? null : mapRef(l.speaker), text: clean(l.text) }))
        .filter((l) => l.text)
        .slice(0, SCRIPT_LIMITS.maxBalloonsPerPanel),
    })),
  }));
  return { title: clean(raw.title), logline: clean(raw.logline), cast, settings, pages: pages.filter((p) => p.panels.length) };
}
