import {
  COMIC_DOC_VERSION,
  type Balloon,
  type PanelCrop,
  type Rect,
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
import { balloonBox, fontSizeFor, letterPanel, speakerPoint, tailTip } from "./lettering";
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

/* ------------------------------------------------------------------ page editor (docs/COMIC.md §2.6, M2) */

const letterOpts = (doc: ComicDoc) => ({ pageWidth: doc.format.width, font: doc.font, direction: doc.readingDirection });
/** Re-letters one panel after a change (automatic balloons move around the manual ones and the faces). */
const reletter = (doc: ComicDoc, panelId: string, fn: (k: Panel) => Panel) => mapPanel(doc, panelId, (k) => letterPanel(fn(k), letterOpts(doc)));
const TAILLESS: LetteringKind[] = ["caption", "sfx"];

/** Shows another of the panel's pictures (an earlier drawing). */
export function selectVariant(doc: ComicDoc, panelId: string, imageId: string): ComicDoc {
  const v = findPanel(doc, panelId)?.panel.variants.find((x) => x.id === imageId);
  return v ? reletter(doc, panelId, (k) => ({ ...k, image: v })) : doc;
}

/** Drops a picture from the panel's variants (never the one shown). */
export function removeVariant(doc: ComicDoc, panelId: string, imageId: string): ComicDoc {
  return mapPanel(doc, panelId, (k) => (k.image?.id === imageId ? k : { ...k, variants: k.variants.filter((v) => v.id !== imageId) }));
}

/** Framing of the picture inside its panel; null = centred, no zoom. Faces move, so the balloons are placed again. */
export function setPanelCrop(doc: ComicDoc, panelId: string, crop: PanelCrop | null): ComicDoc {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
  return reletter(doc, panelId, (k) => {
    const next = { ...k };
    if (!crop || (crop.zoom <= 1 && Math.abs(crop.x - 0.5) < 0.005 && Math.abs(crop.y - 0.5) < 0.005)) delete next.crop;
    else next.crop = { x: clamp(crop.x, 0, 1), y: clamp(crop.y, 0, 1), zoom: clamp(crop.zoom, 1, 4) };
    return next;
  });
}

/** Whether a balloon's text fits its box at its size (hand-placed balloons keep the box they were given). */
export function balloonOverflows(b: Pick<Balloon, "text" | "kind" | "fontSize">, rect: Rect, font: ComicFont) {
  const fit = balloonBox(b.text, b.kind, b.fontSize, rect.w, font);
  return fit.h > rect.h + 1 || fit.w > rect.w + 1;
}

const withOverflow = (b: Balloon, font: ComicFont): Balloon => {
  const out = { ...b };
  delete out.overflow;
  return b.rect && balloonOverflows(b, b.rect, font) ? { ...out, overflow: true } : out;
};

/** Keeps a box on the page and at least two lines tall. */
function clampRect(r: Rect, doc: ComicDoc, pageHeight: number, fontSize: number): Rect {
  const w = Math.round(Math.min(doc.format.width, Math.max(fontSize * 2.5, r.w)));
  const h = Math.round(Math.min(pageHeight, Math.max(fontSize * 1.6, r.h)));
  return { x: Math.round(Math.min(doc.format.width - w, Math.max(0, r.x))), y: Math.round(Math.min(pageHeight - h, Math.max(0, r.y))), w, h };
}

/**
 * A balloon moved, resized or re-aimed by hand: it becomes `manual` (never placed automatically again) and the other
 * balloons of the panel are placed around it. Balloons may cross the panel's border, not the page's.
 */
export function placeBalloon(doc: ComicDoc, panelId: string, balloonId: string, place: { rect: Rect; tail: { x: number; y: number } | null }): ComicDoc {
  const hit = findPanel(doc, panelId);
  if (!hit) return doc;
  const height = hit.page.height;
  return reletter(doc, panelId, (k) => ({
    ...k,
    lettering: k.lettering.map((b) => {
      if (b.id !== balloonId) return b;
      const rect = clampRect(place.rect, doc, height, b.fontSize);
      const tail = TAILLESS.includes(b.kind) || !place.tail ? null : { x: Math.round(Math.min(doc.format.width, Math.max(0, place.tail.x))), y: Math.round(Math.min(height, Math.max(0, place.tail.y))) };
      return withOverflow({ ...b, rect, tail, manual: true }, doc.font);
    }),
  }));
}

export type BalloonEdit = { text?: string; kind?: LetteringKind; speaker?: string | null; fontSize?: number };

/**
 * Text, kind, speaker or size of one balloon. An automatic balloon is simply placed again; a hand-placed one keeps
 * its place: a new size grows or shrinks its box around its centre, a new speaker re-aims its tail.
 */
export function editBalloon(doc: ComicDoc, panelId: string, balloonId: string, edit: BalloonEdit): ComicDoc {
  return reletter(doc, panelId, (k) => ({
    ...k,
    lettering: k.lettering.map((b) => {
      if (b.id !== balloonId) return b;
      const kind = edit.kind ?? b.kind;
      const next: Balloon = {
        ...b,
        kind,
        text: edit.text !== undefined ? edit.text.replace(/[ \t]+/g, " ").trim() : b.text,
        speaker: TAILLESS.includes(kind) ? null : edit.speaker !== undefined ? edit.speaker : b.speaker,
      };
      const sized = edit.fontSize !== undefined && Math.round(edit.fontSize) !== b.fontSize;
      if (!b.manual && !sized) return next;
      // From here on the balloon is (or becomes) hand-placed.
      next.manual = true;
      if (sized) next.fontSize = Math.round(Math.min(doc.format.width * 0.08, Math.max(doc.format.width * 0.012, edit.fontSize!)));
      let rect = b.rect ?? { x: k.rect.x + k.rect.w * 0.1, y: k.rect.y + k.rect.h * 0.08, w: k.rect.w * 0.5, h: k.rect.h * 0.2 };
      if (sized || edit.text !== undefined || edit.kind) {
        const box = balloonBox(next.text, kind, next.fontSize, Math.max(rect.w, k.rect.w * 0.66), doc.font);
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        rect = { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
      }
      const hit = findPanel(doc, panelId)!;
      next.rect = clampRect(rect, doc, hit.page.height, next.fontSize);
      if (TAILLESS.includes(kind)) next.tail = null;
      else if (!next.tail || next.speaker !== b.speaker) {
        const target = speakerPoint(k, next.speaker);
        next.tail = target ? tailTip(next.rect, target, k.rect, next.fontSize) : null;
      }
      return withOverflow(next, doc.font);
    }),
  }));
}

/** Gives a hand-placed balloon back to the automatic lettering. */
export const resetBalloon = (doc: ComicDoc, panelId: string, balloonId: string): ComicDoc =>
  reletter(doc, panelId, (k) => ({ ...k, lettering: k.lettering.map((b) => (b.id === balloonId ? { ...b, manual: false, fontSize: fontSizeFor(b.kind, doc.format.width) } : b)) }));

export function addBalloon(doc: ComicDoc, panelId: string, line: { kind: LetteringKind; speaker: string | null; text: string }, id: (p: string) => string = newId): ComicDoc {
  const text = line.text.replace(/\s+/g, " ").trim();
  if (!text) return doc;
  const [b] = balloonsFor([{ kind: line.kind, speaker: TAILLESS.includes(line.kind) ? null : line.speaker, text }], doc.format.width, id);
  return reletter(doc, panelId, (k) => ({ ...k, lettering: [...k.lettering, b] }));
}

export const deleteBalloon = (doc: ComicDoc, panelId: string, balloonId: string): ComicDoc => reletter(doc, panelId, (k) => ({ ...k, lettering: k.lettering.filter((b) => b.id !== balloonId) }));

/** New texts for some balloons (the shortened lines); every other field stays. */
export function setBalloonTexts(doc: ComicDoc, panelId: string, texts: Record<string, string>): ComicDoc {
  return reletter(doc, panelId, (k) => ({
    ...k,
    lettering: k.lettering.map((b) => {
      const t = texts[b.id]?.replace(/\s+/g, " ").trim();
      if (!t) return b;
      const next = { ...b, text: t };
      return b.manual ? withOverflow(next, doc.font) : next;
    }),
  }));
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
export const docImageKeys = (doc: ComicDoc, opts: { variants?: boolean } = {}) =>
  [...new Set(allPanels(doc).flatMap((k) => [...(k.image ? [k.image.key] : []), ...(opts.variants ? k.variants.map((v) => v.key) : [])]))];
