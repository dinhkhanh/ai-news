import {
  COMIC_DOC_VERSION,
  type Balloon,
  type CastMember,
  type ComicDoc,
  type ComicFont,
  type ComicFormat,
  type ComicPage,
  type LetteringKind,
  type PageLayout,
  type Panel,
  type PanelImage,
  type PanelScript,
  type ReadingDirection,
} from "@ai-news/video/comic";
import { layoutPage } from "./layout";
import { fontSizeFor, letterPanel } from "./lettering";
import type { ComicScript } from "./script";

/**
 * The comic document's pure operations (docs/COMIC.md §7): built from the adaptation, edited in the script review,
 * filled with pictures by the drawing job, re-lettered after each change. Every function returns a new document.
 */

/** Credit on the last page of an AI-drawn comic (on by default, docs/COMIC.md §12). */
export const AI_CREDIT_COMIC = { vi: "Minh hoạ bởi AI (Gemini)", en: "Illustrated with AI (Gemini)" } as const;

export type DocOptions = { format: ComicFormat; readingDirection: ReadingDirection; language: "vi" | "en"; font: ComicFont; credit: string | null };
export type ScriptPage = ComicScript["pages"][number];
export type ScriptPanel = ScriptPage["panels"][number];

let seq = 0;
/** Short unique ids; tests can pass their own generator. */
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function balloonsFor(lettering: ScriptPanel["lettering"], pageWidth: number, id: (p: string) => string): Balloon[] {
  return lettering.map((l) => ({ id: id("b"), kind: l.kind, speaker: l.speaker, text: l.text, rect: null, tail: null, fontSize: fontSizeFor(l.kind, pageWidth), manual: false }));
}

function panelFrom(k: ScriptPanel, pageWidth: number, id: (p: string) => string): Panel {
  const script: PanelScript = { size: k.size, shot: k.shot, settingId: k.settingId, time: k.time, mood: k.mood, characters: k.characters, description: k.description };
  return { id: id("k"), rect: { x: 0, y: 0, w: 0, h: 0 }, script, image: null, variants: [], error: null, lettering: balloonsFor(k.lettering, pageWidth, id) };
}

/** Lays the page's panels out again (after panels were added, removed or resized) and re-letters it. */
export function relayoutPage(page: ComicPage, opts: Pick<DocOptions, "format" | "readingDirection" | "font">): ComicPage {
  const { height, rects } = layoutPage(opts.format, page.panels.map((p) => p.script.size), page.layout, opts.readingDirection);
  const panels = page.panels.map((p, i) => {
    const moved = p.rect.x !== rects[i].x || p.rect.y !== rects[i].y || p.rect.w !== rects[i].w || p.rect.h !== rects[i].h;
    // A panel that moved loses hand-placed balloons' positions: they were relative to the old frame.
    const lettering = moved ? p.lettering.map((b) => ({ ...b, manual: false })) : p.lettering;
    return letterPanel({ ...p, rect: rects[i], lettering }, { pageWidth: opts.format.width, font: opts.font, direction: opts.readingDirection });
  });
  return { ...page, height, panels };
}

export function pageFromScript(p: ScriptPage, opts: DocOptions, id: (p: string) => string = newId): ComicPage {
  return relayoutPage({ id: id("p"), beat: p.beat, layout: p.layout, height: opts.format.height, panels: p.panels.map((k) => panelFrom(k, opts.format.width, id)) }, opts);
}

/** A new document from a normalised adaptation. Cast members carry `characterId` when they are library characters. */
export function buildDoc(script: ComicScript, opts: DocOptions, id: (p: string) => string = newId): ComicDoc {
  const cast: CastMember[] = script.cast.map((c) => ({ ...c, characterId: c.ref.startsWith("new:") ? null : c.ref }));
  return {
    v: COMIC_DOC_VERSION,
    title: script.title,
    logline: script.logline,
    language: opts.language,
    readingDirection: opts.readingDirection,
    format: opts.format,
    font: opts.font,
    credit: opts.credit,
    cast,
    settings: script.settings,
    pages: script.pages.map((p) => pageFromScript(p, opts, id)),
  };
}

const optsOf = (doc: ComicDoc) => ({ format: doc.format, readingDirection: doc.readingDirection, font: doc.font, language: doc.language, credit: doc.credit });

export const allPanels = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels);
export const findPanel = (doc: ComicDoc, panelId: string) => {
  for (const [pi, page] of doc.pages.entries()) {
    const ki = page.panels.findIndex((k) => k.id === panelId);
    if (ki >= 0) return { page, pageIndex: pi, panel: page.panels[ki], panelIndex: ki };
  }
  return null;
};

/** Panels still without a picture (what "Vẽ" draws), in reading order. */
export const panelsToDraw = (doc: ComicDoc) => allPanels(doc).filter((k) => !k.image);

function mapPanel(doc: ComicDoc, panelId: string, fn: (k: Panel) => Panel): ComicDoc {
  return { ...doc, pages: doc.pages.map((p) => (p.panels.some((k) => k.id === panelId) ? { ...p, panels: p.panels.map((k) => (k.id === panelId ? fn(k) : k)) } : p)) };
}

/** A freshly drawn picture becomes the panel's picture (and one more variant); the panel is re-lettered around its faces. */
export function applyPanelImage(doc: ComicDoc, panelId: string, image: PanelImage): ComicDoc {
  return mapPanel(doc, panelId, (k) =>
    letterPanel({ ...k, image, variants: [...k.variants.filter((v) => v.id !== image.id), image], error: null }, { pageWidth: doc.format.width, font: doc.font, direction: doc.readingDirection }),
  );
}

export const setPanelError = (doc: ComicDoc, panelId: string, error: string) => mapPanel(doc, panelId, (k) => ({ ...k, error: error.slice(0, 300) }));

export type PanelEdit = {
  description?: string;
  size?: PanelScript["size"];
  shot?: PanelScript["shot"];
  lettering?: { kind: LetteringKind; speaker: string | null; text: string }[];
};

/**
 * Script review edits of one panel. Changing the lettering re-creates the balloons (automatic placement); changing
 * the size re-lays the whole page out. The picture, if any, stays.
 */
export function editPanel(doc: ComicDoc, panelId: string, edit: PanelEdit, id: (p: string) => string = newId): ComicDoc {
  const hit = findPanel(doc, panelId);
  if (!hit) return doc;
  const k = hit.panel;
  const script: PanelScript = {
    ...k.script,
    ...(edit.description !== undefined ? { description: edit.description.trim() } : {}),
    ...(edit.size ? { size: edit.size } : {}),
    ...(edit.shot ? { shot: edit.shot } : {}),
  };
  const lettering = edit.lettering ? balloonsFor(edit.lettering.filter((l) => l.text.trim()), doc.format.width, id) : k.lettering;
  const panels = hit.page.panels.map((x) => (x.id === panelId ? { ...x, script, lettering } : x));
  const page = relayoutPage({ ...hit.page, panels }, optsOf(doc));
  return { ...doc, pages: doc.pages.map((p, i) => (i === hit.pageIndex ? page : p)) };
}

export function deletePanel(doc: ComicDoc, panelId: string): ComicDoc {
  const hit = findPanel(doc, panelId);
  if (!hit) return doc;
  const panels = hit.page.panels.filter((k) => k.id !== panelId);
  if (!panels.length) return deletePage(doc, hit.page.id);
  const page = relayoutPage({ ...hit.page, panels }, optsOf(doc));
  return { ...doc, pages: doc.pages.map((p, i) => (i === hit.pageIndex ? page : p)) };
}

export function addPanel(doc: ComicDoc, pageId: string, description: string, id: (p: string) => string = newId): ComicDoc {
  return {
    ...doc,
    pages: doc.pages.map((p) =>
      p.id === pageId
        ? relayoutPage(
            { ...p, panels: [...p.panels, panelFrom({ size: "medium", shot: "medium", settingId: null, time: "", mood: "", characters: [], description: description.trim(), lettering: [] }, doc.format.width, id)] },
            optsOf(doc),
          )
        : p,
    ),
  };
}

export const deletePage = (doc: ComicDoc, pageId: string): ComicDoc => ({ ...doc, pages: doc.pages.filter((p) => p.id !== pageId) });

export function setPageLayout(doc: ComicDoc, pageId: string, layout: PageLayout): ComicDoc {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? relayoutPage({ ...p, layout }, optsOf(doc)) : p)) };
}

/** Replaces one page with a re-adapted one ("Viết lại trang này"); the new page's panels have no pictures yet. */
export function replacePage(doc: ComicDoc, pageId: string, page: ScriptPage, id: (p: string) => string = newId): ComicDoc {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? { ...pageFromScript(page, optsOf(doc), id), id: p.id } : p)) };
}

/** Drops a proposed character: out of the cast, out of every panel, their lines become captions. */
export function dropCast(doc: ComicDoc, ref: string): ComicDoc {
  const pages = doc.pages.map((p) =>
    relayoutPage(
      {
        ...p,
        panels: p.panels.map((k) => ({
          ...k,
          script: { ...k.script, characters: k.script.characters.filter((c) => c.ref !== ref) },
          lettering: k.lettering.map((b) => (b.speaker === ref ? { ...b, speaker: null, kind: "caption" as const, manual: false } : b)),
        })),
      },
      optsOf(doc),
    ),
  );
  return { ...doc, cast: doc.cast.filter((c) => c.ref !== ref), pages };
}

/** Folds one cast member into another (the adaptation split one person in two, or proposed someone already in the library). */
export function mergeCast(doc: ComicDoc, from: string, into: string): ComicDoc {
  if (from === into || !doc.cast.some((c) => c.ref === into)) return doc;
  const pages = doc.pages.map((p) => ({
    ...p,
    panels: p.panels.map((k) => ({
      ...k,
      script: { ...k.script, characters: k.script.characters.map((c) => (c.ref === from ? { ...c, ref: into } : c)).filter((c, i, all) => all.findIndex((x) => x.ref === c.ref) === i) },
      lettering: k.lettering.map((b) => (b.speaker === from ? { ...b, speaker: into } : b)),
    })),
  }));
  return { ...doc, cast: doc.cast.filter((c) => c.ref !== from), pages };
}

/** Links a proposed (`new:`) cast member to the library character created for it; the ref stays, so panels need no change. */
export const linkCast = (doc: ComicDoc, ref: string, characterId: string): ComicDoc => ({ ...doc, cast: doc.cast.map((c) => (c.ref === ref ? { ...c, characterId } : c)) });

export function editCast(doc: ComicDoc, ref: string, edit: Partial<Pick<CastMember, "name" | "role" | "visual" | "personality">>): ComicDoc {
  return { ...doc, cast: doc.cast.map((c) => (c.ref === ref ? { ...c, ...Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, String(v ?? "").trim()])) } : c)) };
}

/** Numbers shown before drawing (the estimate) and on the list. */
export function docStats(doc: ComicDoc) {
  const panels = allPanels(doc);
  return {
    pages: doc.pages.length,
    panels: panels.length,
    drawn: panels.filter((k) => k.image).length,
    failed: panels.filter((k) => !k.image && k.error).length,
    balloons: panels.reduce((s, k) => s + k.lettering.length, 0),
    overflow: panels.reduce((s, k) => s + k.lettering.filter((b) => b.overflow).length, 0),
  };
}

/** Every R2 key the document's pictures use (presign them before showing a page). */
export const docImageKeys = (doc: ComicDoc) => [...new Set(allPanels(doc).flatMap((k) => (k.image ? [k.image.key] : [])))];
