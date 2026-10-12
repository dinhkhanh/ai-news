import type { Brand } from "@ai-news/video/schema";
import type { TimedWord } from "@/lib/media/align";
import { editorDocSchema, type EditorDoc, type EditorScene } from "@/lib/media/editor";
import { frameStill, overlayZones } from "@/lib/media/framing";
import type { ComicScriptMeta } from "./motion";

/**
 * The editor document of a motion comic (docs/COMIC.md §11.1): one shot per beat, the beat's panel (copied into the
 * project's media) framed by the face guard on whoever speaks, or on every face for the narrator and silent beats.
 * A wide panel is drawn full width on its blurred backdrop by the composition; a tall or square one is cover-cropped
 * around that focus with the Ken Burns move. Pure (tested in comic.test.ts); `prepare-comic.ts` supplies the parts.
 */
export function composeComicDoc(input: {
  title: string;
  language: "vi" | "en";
  comic: ComicScriptMeta;
  scenes: { id: string; kind: "hook" | "body" | "cta"; voiceover: string; onScreenText: string; durationSec: number }[];
  brand: Brand;
  hasChannelLogo: boolean;
  voices: { sceneId: string; key: string; durationMs: number; words: TimedWord[] }[];
  /** comic_images.id → the project's copy of the picture. */
  panels: Record<string, { assetId: string; key: string; credit: string }>;
  music: { key: string; attribution: string; title: string; source: "mubert" | "library"; licence: string } | null;
}): EditorDoc {
  const scenes: EditorScene[] = input.scenes.map((sc) => {
    const m = input.comic.scenes[sc.id];
    if (!m) throw new Error(`Scene ${sc.id} has no panel`);
    const p = input.panels[m.imageId];
    if (!p) throw new Error(`The picture of panel ${m.panelId} was not copied`);
    const v = input.voices.find((x) => x.sceneId === sc.id) ?? null;
    const zones = overlayZones({ kind: sc.kind, headline: sc.onScreenText, caption: input.brand.caption, headlineStyle: input.brand.headline, hasCaptions: Boolean(v), showSource: input.brand.showSource, hasLogo: Boolean(input.brand.logoSrc) || input.hasChannelLogo });
    const faces = (m.face ? [m.face] : m.faces).map((f) => ({ ...f, confidence: 1 }));
    const f = frameStill({ width: m.width, height: m.height, faces }, zones);
    return {
      id: sc.id,
      kind: sc.kind,
      onScreenText: sc.onScreenText,
      voiceover: sc.voiceover,
      brollTerms: [],
      newsTerms: [],
      durationSec: sc.durationSec,
      voice: v ? { key: v.key, durationMs: v.durationMs, words: v.words } : null,
      visual: { kind: "image", key: p.key, kenBurns: f.kenBurns, focus: f.focus, sketch: null, credit: p.credit, assetId: p.assetId, thumbnailUrl: null },
      shots: [],
      holdMs: 0,
      overlay: true,
      captions: null,
    };
  });
  return editorDocSchema.parse({
    v: 1,
    title: input.title,
    language: input.language,
    // No link to credit: the outro names the story ("Nguồn: Truyện “<title>”").
    source: { name: input.language === "en" ? `Comic “${input.comic.title}”` : `Truyện “${input.comic.title}”`, url: "" },
    brand: input.brand,
    scenes,
    music: input.music ? { key: input.music.key, gainDb: -12, attribution: input.music.attribution, title: input.music.title, source: input.music.source, licence: input.music.licence } : null,
    coverAtSec: null,
  });
}
