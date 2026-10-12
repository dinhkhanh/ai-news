"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { findPanel, setBalloonTexts } from "@/lib/comic/doc";
import { applyEditorOp, editorOpSchema, OP_ACTIVITY } from "@/lib/comic/editor-ops";
import { shortenLines } from "@/lib/comic/shorten";
import { addComicCost, loadComic, styleOf, updateDoc } from "@/lib/comic/service";
import { flagEnabled } from "@/lib/flags";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * Page editor actions (docs/COMIC.md §2.6). Called from the editor's own handlers (drag, inspector) rather than a
 * form, so they take plain objects and return `{ ok, message }`. Every change is a new document version.
 */

export type EditorResult = { ok: true; message?: string; versionId: string } | { ok: false; message: string };

const fail = (e: unknown): EditorResult => ({ ok: false, message: e instanceof Error ? e.message : "Có lỗi xảy ra" });

async function writer() {
  const w = await assertWorkspaceWriter();
  if (!(await flagEnabled("comics"))) throw new Error("Truyện tranh đang tắt (cờ comics trong /admin/integrations)");
  return w;
}

export async function applyEdit(input: { comicId: string; op: unknown }): Promise<EditorResult> {
  try {
    const { ws, log } = await writer();
    const op = editorOpSchema.parse(input.op);
    const res = await updateDoc(ws, input.comicId, "edit", (doc) => {
      const next = applyEditorOp(doc, op);
      return next === doc ? null : { doc: next, changes: { op: op.type, ...("panelId" in op ? { panelId: op.panelId } : { pageId: op.pageId }) } };
    });
    if (res.changed) await log(OP_ACTIVITY[op.type], { comicId: input.comicId, ...op, ...(op.type === "addBalloon" || op.type === "balloon" ? { text: undefined } : {}) });
    revalidatePath(`/app/comics/${input.comicId}`);
    return { ok: true, versionId: res.versionId };
  } catch (e) {
    return fail(e);
  }
}

/** "Rút gọn lời thoại": Claude shortens the lines of a panel that do not fit their balloons. */
export async function shortenPanel(input: { comicId: string; panelId: string }): Promise<EditorResult> {
  try {
    const { ws, log } = await writer();
    const loaded = await loadComic(ws, input.comicId);
    const hit = loaded?.version ? findPanel(loaded.version.doc, input.panelId) : null;
    if (!loaded?.version || !hit) throw new Error("Không tìm thấy khung này");
    const ids = hit.panel.lettering.filter((b) => b.overflow).map((b) => b.id);
    if (!ids.length) throw new Error("Lời thoại của khung này đã vừa bóng");
    const { texts, costUsd } = await shortenLines(loaded.version.doc, hit.panel, ids, loaded.comic.textModel, { ...ws, comicId: input.comicId });
    await addComicCost(ws, input.comicId, costUsd);
    const res = await updateDoc(ws, input.comicId, "letter", (doc) => (findPanel(doc, input.panelId) ? { doc: setBalloonTexts(doc, input.panelId, texts), changes: { shortened: Object.keys(texts), panelId: input.panelId } } : null));
    await log("comic.lines_shortened", { comicId: input.comicId, panelId: input.panelId, lines: Object.keys(texts).length, costUsd });
    revalidatePath(`/app/comics/${input.comicId}`);
    const left = res.changed ? (findPanel(res.doc, input.panelId)?.panel.lettering.filter((b) => b.overflow).length ?? 0) : ids.length;
    return { ok: true, versionId: res.versionId, message: left ? `Đã rút gọn; còn ${left} lời vẫn dài: sửa tay hoặc kéo to bóng` : "Đã rút gọn lời thoại" };
  } catch (e) {
    return fail(e);
  }
}

/**
 * "Dùng làm mẫu phong cách": a good panel becomes one of the style's samples (at most 4), sent with every later panel
 * of this comic and of every comic in the style. Platform presets cannot change: copy one into the workspace first.
 */
export async function addStyleSample(input: { comicId: string; panelId: string }): Promise<EditorResult> {
  try {
    const { ws, log } = await writer();
    const loaded = await loadComic(ws, input.comicId);
    const key = loaded?.version ? findPanel(loaded.version.doc, input.panelId)?.panel.image?.key : null;
    if (!loaded || !key) throw new Error("Khung này chưa có hình");
    const styleId = loaded.comic.styleId;
    await withOrgContext(ws, async (tx) => {
      const style = styleId ? await tx.query.comicStyles.findFirst({ where: and(eq(schema.comicStyles.id, styleId), eq(schema.comicStyles.organizationId, ws.organizationId)) }) : undefined;
      if (!style) throw new Error("Phong cách mẫu của hệ thống không sửa được: nhân bản nó trong “Phong cách” rồi chọn bản của workspace cho truyện sau");
      if (style.referenceKeys.includes(key)) throw new Error("Hình này đã là mẫu của phong cách");
      if (style.referenceKeys.length >= 4) throw new Error("Phong cách đã đủ 4 hình mẫu: bỏ bớt một hình trong “Phong cách”");
      const referenceKeys = [...style.referenceKeys, key];
      await tx.update(schema.comicStyles).set({ referenceKeys }).where(eq(schema.comicStyles.id, style.id));
      // This comic follows its snapshot of the style: the sample counts for its next drawings too.
      const snapshot = { ...styleOf(loaded.comic), referenceKeys: [...new Set([...styleOf(loaded.comic).referenceKeys, key])] };
      await tx.update(schema.comics).set({ styleSnapshot: snapshot as unknown as Record<string, unknown> }).where(eq(schema.comics.id, input.comicId));
    });
    await log("comic_style.sample_added", { comicId: input.comicId, panelId: input.panelId, styleId, key });
    revalidatePath(`/app/comics/${input.comicId}`);
    return { ok: true, versionId: loaded.version!.id, message: "Đã thêm vào mẫu của phong cách" };
  } catch (e) {
    return fail(e);
  }
}
