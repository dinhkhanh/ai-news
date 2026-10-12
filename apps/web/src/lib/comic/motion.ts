import type { CharacterPosition, ComicDoc, LetteringKind, Panel } from "@ai-news/video/comic";
import type { Scene, StoredScript } from "@/lib/llm/schemas";

/**
 * Motion comic (docs/COMIC.md §11.1, M4): a comic document becomes the script of a 9:16 video without any model
 * call. One scene per lettering beat in reading order, over its panel: speech / thought / whisper / shout are read
 * by the speaker's voice, captions by the narrator, a panel with nothing to read is a short silent beat, and sound
 * effects become the scene's on-screen text. The first beat is the hook (the title on screen), a narrator line
 * closes the video. Pure, no I/O (tested in comic.test.ts); the build is `inngest/functions/prepare-comic.ts`.
 */

type Box = { x: number; y: number; w: number; h: number };

/** Who reads a beat: a cast member (their character's voice, else the narrator's), the narrator, or nobody. */
export type BeatReader = { kind: "character"; ref: string; characterId: string | null } | { kind: "narrator" } | null;

/** What the build needs of each scene besides the script: the panel it shows and who reads it. */
export type ComicSceneMeta = {
  page: number;
  panelId: string;
  /** comic_images.id of the picture shown, its key and size. */
  imageId: string;
  key: string;
  width: number;
  height: number;
  /** Every face in the picture (normalised), and the speaker's when it could be told apart. */
  faces: Box[];
  face: Box | null;
  reader: BeatReader;
  lettering: LetteringKind | null;
};

/** `scripts.scenes_json.comic` of a motion comic. */
export type ComicScriptMeta = {
  comicId: string;
  versionId: string;
  title: string;
  /** 1-based pages the video covers, both ends included. */
  pages: { from: number; to: number };
  episode: { n: number; of: number } | null;
  music: boolean;
  scenes: Record<string, ComicSceneMeta>;
};

export type ComicScript = StoredScript & { comic: ComicScriptMeta };

/** Seconds of a silent panel, and of one with only a sound effect. */
export const SILENT_BEAT_SEC = 2.5;
export const SFX_BEAT_SEC = 2;
/** Reading speed the length estimate assumes (TTS reads about this fast). */
const WORDS_PER_SEC = 2.8;

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const spokenSec = (t: string) => Math.max(1.5, Math.round((words(t) / WORDS_PER_SEC + 0.5) * 10) / 10);

const POSITION_X: Record<CharacterPosition, number> = { left: 0.25, center: 0.5, right: 0.75, background: 0.5 };

/**
 * The speaker's face in a drawn panel. Faces carry no names, so the panel script's staging decides: with as many
 * faces as characters in the foreground, the n-th face from the left is the n-th character from the left; otherwise
 * the face nearest to where the speaker stands. Null when the panel has no faces or the speaker is not in it.
 */
export function speakerFace(panel: Panel, ref: string | null): Box | null {
  const faces = [...(panel.image?.faces ?? [])].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2));
  if (!faces.length || !ref) return null;
  const front = panel.script.characters.filter((c) => c.position !== "background");
  const who = panel.script.characters.find((c) => c.ref === ref);
  if (!who) return null;
  if (faces.length === 1) return faces[0];
  const order: CharacterPosition[] = ["left", "center", "right"];
  const sorted = [...front].sort((a, b) => order.indexOf(a.position) - order.indexOf(b.position));
  const at = sorted.findIndex((c) => c.ref === ref);
  if (sorted.length === faces.length && at >= 0) return faces[at];
  const x = POSITION_X[who.position];
  return faces.reduce((best, f) => (Math.abs(f.x + f.w / 2 - x) < Math.abs(best.x + best.w / 2 - x) ? f : best));
}

export type MotionBeat = Omit<Scene, "supportingSentence"> & { meta: ComicSceneMeta };

export type MotionOptions = {
  /** 1-based pages, both ends included; default every page. */
  pages?: { from: number; to: number };
  episode?: { n: number; of: number } | null;
};

/** The pages a request covers, clamped to the document. */
export function pageRange(doc: Pick<ComicDoc, "pages">, pages?: { from: number; to: number }) {
  const last = doc.pages.length;
  const from = Math.min(Math.max(1, Math.round(pages?.from ?? 1)), Math.max(1, last));
  const to = Math.min(Math.max(from, Math.round(pages?.to ?? last)), last);
  return { from, to };
}

/**
 * The beats of the chosen pages in reading order. Panels not drawn yet are left out (`skipped`): a video shows
 * pictures, and a beat over an empty frame would be a hole in it.
 */
export function comicBeats(doc: ComicDoc, opts: MotionOptions = {}): { beats: MotionBeat[]; skipped: number } {
  const range = pageRange(doc, opts.pages);
  const castById = new Map(doc.cast.map((c) => [c.ref, c]));
  const beats: MotionBeat[] = [];
  let skipped = 0;
  doc.pages.slice(range.from - 1, range.to).forEach((page, pi) => {
    for (const panel of page.panels) {
      if (!panel.image) {
        skipped += 1;
        continue;
      }
      const meta = (reader: BeatReader, lettering: LetteringKind | null, speaker: string | null): ComicSceneMeta => ({
        page: range.from + pi,
        panelId: panel.id,
        imageId: panel.image!.id,
        key: panel.image!.key,
        width: panel.image!.width,
        height: panel.image!.height,
        faces: panel.image!.faces ?? [],
        face: speakerFace(panel, speaker),
        reader,
        lettering,
      });
      const sfx = panel.lettering
        .filter((b) => b.kind === "sfx" && b.text.trim())
        .map((b) => b.text.trim())
        .join(" ");
      const spoken = panel.lettering.filter((b) => b.kind !== "sfx" && b.text.trim());
      if (!spoken.length) {
        beats.push({ id: "", kind: "body", voiceover: "", onScreenText: sfx, brollTerms: [], newsTerms: [], durationSec: sfx ? SFX_BEAT_SEC : SILENT_BEAT_SEC, meta: meta(null, sfx ? "sfx" : null, null) });
        continue;
      }
      spoken.forEach((b, i) => {
        const cast = b.kind !== "caption" && b.speaker ? castById.get(b.speaker) : undefined;
        const reader: BeatReader = cast ? { kind: "character", ref: cast.ref, characterId: cast.characterId } : { kind: "narrator" };
        beats.push({ id: "", kind: "body", voiceover: b.text.trim(), onScreenText: i === 0 ? sfx : "", brollTerms: [], newsTerms: [], durationSec: spokenSec(b.text), meta: meta(reader, b.kind, cast ? cast.ref : null) });
      });
    }
  });
  return { beats, skipped };
}

/** The narrator's closing line: the end of the story, or of one episode of it. */
export function closingLine(language: "vi" | "en", title: string, episode: { n: number; of: number } | null) {
  const more = episode && episode.n < episode.of;
  if (language === "en") return { voiceover: more ? `To be continued. Follow for part ${episode!.n + 1} of “${title}”.` : `The end of “${title}”. Follow for the next story.`, onScreenText: more ? "To be continued…" : "Follow for more" };
  return { voiceover: more ? `Còn tiếp. Theo dõi kênh để xem tập ${episode!.n + 1} của “${title}”.` : `Hết truyện “${title}”. Theo dõi kênh để xem truyện tiếp theo.`, onScreenText: more ? "Còn tiếp…" : "Theo dõi để xem tiếp" };
}

/** The video's title: the comic's, with the episode when it is split. */
export function motionTitle(title: string, episode: { n: number; of: number } | null, language: "vi" | "en") {
  return episode ? `${title} · ${language === "en" ? "Part" : "Tập"} ${episode.n}/${episode.of}` : title;
}

/**
 * The stored script of a motion comic: the beats as scenes s1…sN (the first is the hook, with the title on
 * screen), a narrator CTA over the last picture, platform metadata from the title and logline, and the per-scene
 * comic data the build reads (`comic.scenes`). Null when the pages have nothing drawn.
 */
export function comicToScript(doc: ComicDoc, ids: { comicId: string; versionId: string }, opts: MotionOptions & { music?: boolean } = {}): { script: ComicScript; skipped: number } | null {
  const { beats, skipped } = comicBeats(doc, opts);
  if (!beats.length) return null;
  const episode = opts.episode ?? null;
  const language = doc.language;
  const title = doc.title.trim() || (language === "en" ? "Untitled comic" : "Truyện chưa đặt tên");
  const end = closingLine(language, title, episode);
  const last = beats[beats.length - 1];
  const all: MotionBeat[] = [
    ...beats.map((b, i) => (i === 0 ? { ...b, kind: "hook" as const, onScreenText: motionTitle(title, episode, language) } : b)),
    { id: "", kind: "cta" as const, voiceover: end.voiceover, onScreenText: end.onScreenText, brollTerms: [], newsTerms: [], durationSec: spokenSec(end.voiceover), meta: { ...last.meta, face: null, reader: { kind: "narrator" as const }, lettering: null } },
  ].map((b, i) => ({ ...b, id: `s${i + 1}` }));
  const videoTitle = motionTitle(title, episode, language);
  const tags = language === "en" ? ["comic", "shortstory", "webcomic", "motioncomic"] : ["truyentranh", "truyenngan", "comic", "motioncomic"];
  const description = [doc.logline.trim(), language === "en" ? "Illustrated with AI." : "Truyện tranh minh hoạ bằng AI."].filter(Boolean).join("\n\n");
  const meta = { title: videoTitle.slice(0, 100), description, hashtags: tags };
  const durationSec = Math.round(all.reduce((a, b) => a + b.durationSec, 0));
  const script: ComicScript = {
    title: videoTitle,
    scenes: all.map((b) => ({ id: b.id, kind: b.kind, voiceover: b.voiceover, onScreenText: b.onScreenText, brollTerms: b.brollTerms, newsTerms: b.newsTerms, durationSec: b.durationSec, supportingSentence: null })),
    estimatedDurationSec: durationSec,
    metadata: { youtube: meta, facebook: meta, tiktok: meta },
    sensitiveTopic: false,
    notes: null,
    generation: { language, durationSec, tone: "story", model: "comic", templateId: null, templateVersion: 0, latencyMs: 0, stopReason: null, servedBy: null },
    comic: { ...ids, title, pages: pageRange(doc, opts.pages), episode, music: opts.music ?? true, scenes: Object.fromEntries(all.map((b) => [b.id, b.meta])) },
  };
  return { script, skipped };
}

/** Rough length in seconds of a video made from these pages (the editor shows the real one after the voices). */
export function estimateMotionSec(doc: ComicDoc, pages?: { from: number; to: number }) {
  const { beats } = comicBeats(doc, { pages });
  return beats.length ? Math.round(beats.reduce((a, b) => a + b.durationSec, 0) + MOTION_OVERHEAD_SEC) : 0;
}

/** "Chia thành tập": consecutive page ranges of `perEpisode` pages, the last one taking what is left. */
export function episodeRanges(range: { from: number; to: number }, perEpisode: number): { from: number; to: number }[] {
  const size = Math.max(1, Math.round(perEpisode));
  const out: { from: number; to: number }[] = [];
  for (let p = range.from; p <= range.to; p += size) out.push({ from: p, to: Math.min(range.to, p + size - 1) });
  return out;
}

/** Seconds of video each page gives (its beats), for the live estimate of the "Làm video" form. */
export function pageSeconds(doc: ComicDoc): number[] {
  return doc.pages.map((_, i) => {
    const { beats } = comicBeats(doc, { pages: { from: i + 1, to: i + 1 } });
    return Math.round(beats.reduce((a, b) => a + b.durationSec, 0) * 10) / 10;
  });
}

/** What the closing narrator line, the lead-in and the gaps add to a video, on average (seconds). */
export const MOTION_OVERHEAD_SEC = 5;
