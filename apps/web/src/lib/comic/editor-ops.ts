import { z } from "zod";
import { LETTERING_KINDS, PAGE_LAYOUTS, type ComicDoc } from "@ai-news/video/comic";
import { addBalloon, deleteBalloon, editBalloon, findPanel, placeBalloon, removeVariant, resetBalloon, selectVariant, setPageLayout, setPanelCrop } from "./doc";

/**
 * Page editor operations (docs/COMIC.md §2.6). The browser applies an operation to its copy of the document at once
 * (same pure functions) and sends it to the server, which applies it to the current version under the row lock; the
 * operations name panels and balloons by id, so two edits in a row, or an edit during a drawing run, compose.
 */

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive() });
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const id = z.string().min(1).max(80);

export const editorOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("place"), panelId: id, balloonId: id, rect, tail: point.nullable() }),
  z.object({
    type: z.literal("balloon"),
    panelId: id,
    balloonId: id,
    edit: z.object({ text: z.string().max(300).optional(), kind: z.enum(LETTERING_KINDS).optional(), speaker: z.string().max(80).nullable().optional(), fontSize: z.number().finite().positive().optional() }),
  }),
  z.object({ type: z.literal("resetBalloon"), panelId: id, balloonId: id }),
  z.object({ type: z.literal("addBalloon"), panelId: id, balloonId: z.string().regex(/^b[a-z0-9]{4,40}$/), kind: z.enum(LETTERING_KINDS), speaker: z.string().max(80).nullable(), text: z.string().min(1).max(300) }),
  z.object({ type: z.literal("deleteBalloon"), panelId: id, balloonId: id }),
  z.object({ type: z.literal("variant"), panelId: id, imageId: id }),
  z.object({ type: z.literal("removeVariant"), panelId: id, imageId: id }),
  z.object({ type: z.literal("crop"), panelId: id, crop: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite() }).nullable() }),
  z.object({ type: z.literal("layout"), pageId: id, layout: z.enum(PAGE_LAYOUTS) }),
]);
export type EditorOp = z.infer<typeof editorOpSchema>;

/** Activity type logged for each operation. */
export const OP_ACTIVITY: Record<EditorOp["type"], string> = {
  place: "comic.balloon_moved",
  balloon: "comic.balloon_edited",
  resetBalloon: "comic.balloon_reset",
  addBalloon: "comic.balloon_added",
  deleteBalloon: "comic.balloon_deleted",
  variant: "comic.variant_selected",
  removeVariant: "comic.variant_removed",
  crop: "comic.panel_cropped",
  layout: "comic.layout_changed",
};

/** Applies one operation; an operation on a panel or balloon that no longer exists returns the document unchanged. */
export function applyEditorOp(doc: ComicDoc, op: EditorOp): ComicDoc {
  if (op.type === "layout") return doc.pages.some((p) => p.id === op.pageId) ? setPageLayout(doc, op.pageId, op.layout) : doc;
  const hit = findPanel(doc, op.panelId);
  if (!hit) return doc;
  const hasBalloon = (bid: string) => hit.panel.lettering.some((b) => b.id === bid);
  const speaker = (ref: string | null | undefined) => (ref && doc.cast.some((c) => c.ref === ref) ? ref : null);
  switch (op.type) {
    case "place":
      return hasBalloon(op.balloonId) ? placeBalloon(doc, op.panelId, op.balloonId, { rect: op.rect, tail: op.tail }) : doc;
    case "balloon":
      return hasBalloon(op.balloonId) ? editBalloon(doc, op.panelId, op.balloonId, op.edit.speaker !== undefined ? { ...op.edit, speaker: speaker(op.edit.speaker) } : op.edit) : doc;
    case "resetBalloon":
      return hasBalloon(op.balloonId) ? resetBalloon(doc, op.panelId, op.balloonId) : doc;
    case "addBalloon": {
      // The browser picks the id, so its copy and the server's agree without a reload.
      const taken = doc.pages.some((p) => p.panels.some((k) => k.lettering.some((b) => b.id === op.balloonId)));
      return taken ? doc : addBalloon(doc, op.panelId, { kind: op.kind, speaker: speaker(op.speaker), text: op.text }, () => op.balloonId);
    }
    case "deleteBalloon":
      return deleteBalloon(doc, op.panelId, op.balloonId);
    case "variant":
      return selectVariant(doc, op.panelId, op.imageId);
    case "removeVariant":
      return removeVariant(doc, op.panelId, op.imageId);
    case "crop":
      return setPanelCrop(doc, op.panelId, op.crop);
  }
}
