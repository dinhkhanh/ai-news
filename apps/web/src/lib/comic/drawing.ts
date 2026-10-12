import "server-only";
import type { ComicDoc, Panel } from "@ai-news/video/comic";
import { findPanel } from "./doc";
import { imageModel } from "./models";
import { snapAspect } from "./layout";
import { panelPrompt, pickRefs, refsNote, sheetPrompt, type ComicStyle } from "./prompts";

/** What to send for one panel or one sheet (docs/COMIC.md §6); the jobs pass it to `drawComicImage`. */

export type PanelRequest = { prompt: string; refKeys: string[]; aspect: string };

/**
 * The prompt and reference images of a panel: the sheets of the characters in it, the first drawn panel of the same
 * setting, the style's samples and the previous drawn panel of the page, cut to the model's limit.
 */
export function panelRequest(doc: ComicDoc, panel: Panel, style: ComicStyle, sheetKeyByRef: Map<string, string>, modelId: string, instruction?: string | null): PanelRequest {
  const model = imageModel(modelId);
  const aspect = snapAspect(panel.rect.w, panel.rect.h, model.aspectRatios);
  const hit = findPanel(doc, panel.id);
  const all = doc.pages.flatMap((p) => p.panels);
  const settingAnchor = panel.script.settingId ? all.find((k) => k.id !== panel.id && k.script.settingId === panel.script.settingId && k.image)?.image?.key ?? null : null;
  const previous = hit ? [...hit.page.panels.slice(0, hit.panelIndex)].reverse().find((k) => k.image)?.image?.key ?? null : null;
  const candidates = {
    sheets: panel.script.characters.flatMap((c) => (sheetKeyByRef.get(c.ref) ? [sheetKeyByRef.get(c.ref)!] : [])),
    setting: settingAnchor,
    style: style.referenceKeys,
    previous,
  };
  const refKeys = pickRefs(candidates, model.maxRefs);
  return { prompt: panelPrompt(doc, panel, style, { aspect, refsNote: refsNote(candidates, refKeys), instruction }), refKeys, aspect };
}

export function sheetRequest(member: { name: string; visual: string }, style: ComicStyle, referenceKeys: string[], modelId: string, instruction?: string | null): PanelRequest {
  const model = imageModel(modelId);
  const refKeys = referenceKeys.slice(0, model.maxRefs);
  const note = refKeys.length ? " Match the character in the reference images (redrawn in the art style)." : "";
  return { prompt: sheetPrompt(member, style, instruction) + note, refKeys, aspect: "3:2" };
}
