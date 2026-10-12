"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { LETTERING_KINDS, PAGE_LAYOUTS, PANEL_SIZES, SHOTS, type LetteringKind, type PageLayout, type PanelSize, type Shot } from "@ai-news/video/comic";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { comicAdaptRequested, comicCastRequested, comicDrawRequested, comicExportRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { addPanel, deletePage, deletePanel, dropCast, editCast, editPanel, mergeCast, setPageLayout } from "@/lib/comic/doc";
import { approveScript } from "@/lib/comic/flow";
import { pageFormat } from "@/lib/comic/layout";
import { DEFAULT_IMAGE_MODEL, DEFAULT_TEXT_MODEL, isImageModel, isTextModel } from "@/lib/comic/models";
import type { ComicStyle } from "@/lib/comic/prompts";
import { STORY_LIMITS } from "@/lib/comic/script";
import { claimBusy, clearBusy, comicDrawAccess, loadComic, updateDoc } from "@/lib/comic/service";
import { flagEnabled } from "@/lib/flags";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * Comic studio actions (docs/COMIC.md §2). Any workspace writer may use them while flag `comics` is on (§13.4).
 * Document edits go through `updateDoc` (new immutable version); long work is queued on Inngest with the comic's
 * busy flag claimed first, so two steps never run at once.
 */

const { min: STORY_MIN_CHARS, max: STORY_MAX_CHARS } = STORY_LIMITS;

async function writer() {
  const w = await assertWorkspaceWriter();
  if (!(await flagEnabled("comics"))) throw new Error("Truyện tranh đang tắt (cờ comics trong /admin/integrations)");
  return w;
}

const pick = <T extends string>(v: string, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const comicPath = (id: string, tab?: string) => `/app/comics/${id}${tab ? `?tab=${tab}` : ""}`;

export async function createComic(_: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await writer();
    const story = String(fd.get("story") ?? "").replace(/\r\n?/g, "\n").trim();
    if (story.length < STORY_MIN_CHARS) throw new Error(`Câu chuyện cần ít nhất ${STORY_MIN_CHARS} ký tự`);
    if (story.length > STORY_MAX_CHARS) throw new Error(`Câu chuyện dài quá ${STORY_MAX_CHARS.toLocaleString("vi-VN")} ký tự: rút gọn hoặc chia thành nhiều truyện`);
    const title = str(fd, "title").slice(0, 120) || null;
    const language = str(fd, "language") === "en" ? "en" : "vi";
    const exact = str(fd, "pagesMode") === "exact";
    const pages = exact ? Math.round(Number(str(fd, "pages"))) : null;
    if (exact && !(pages && pages >= 1 && pages <= 40)) throw new Error("Số trang từ 1 đến 40");
    const format = pageFormat(str(fd, "format")).id;
    const textModel = isTextModel(str(fd, "textModel")) ? str(fd, "textModel") : DEFAULT_TEXT_MODEL;
    const imageModel = isImageModel(str(fd, "imageModel")) ? str(fd, "imageModel") : DEFAULT_IMAGE_MODEL;
    const audience = pick(str(fd, "audience"), ["kids", "general", "adult"] as const, "general");
    const dialogue = pick(str(fd, "dialogue"), ["low", "medium", "high"] as const, "medium");
    const styleId = str(fd, "styleId");
    const castIds = fd.getAll("castIds").map(String).filter(Boolean).slice(0, 20);

    const { style, cast } = await withOrgContext(ws, async (tx) => ({
      style: styleId ? await tx.query.comicStyles.findFirst({ where: and(eq(schema.comicStyles.id, styleId), or(isNull(schema.comicStyles.organizationId), eq(schema.comicStyles.organizationId, ws.organizationId))) }) : undefined,
      cast: castIds.length ? await tx.select({ id: schema.comicCharacters.id }).from(schema.comicCharacters).where(and(inArray(schema.comicCharacters.id, castIds), eq(schema.comicCharacters.organizationId, ws.organizationId))) : [],
    }));
    if (!style) throw new Error("Chọn một phong cách");
    const snapshot: ComicStyle = { id: style.id, name: style.name, prompt: style.prompt, negative: style.negative, colourMode: style.colourMode === "bw" ? "bw" : "colour", storytellingNotes: style.storytellingNotes, referenceKeys: style.referenceKeys };
    const direction = pick(str(fd, "readingDirection"), ["ltr", "rtl", "style"] as const, "style");
    const readingDirection = direction === "style" ? (style.readingDirection === "rtl" ? "rtl" : "ltr") : direction;
    const review = fd.get("review") === "on";
    const options = { dialogue, free: fd.get("free") === "on", review, castIds: cast.map((c) => c.id), font: style.font, credit: true };

    // Without review the drawing follows at once: refuse now rather than after the script was paid for.
    if (!review) {
      const access = await comicDrawAccess(ws.userId);
      if (!access.ok) throw new Error(access.reason);
    }
    const [comic] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.comics)
        .values({
          organizationId: ws.organizationId, ownerId: ws.userId, title, story, language, pageTarget: pages, format, readingDirection, styleId: style.id,
          styleSnapshot: snapshot as unknown as Record<string, unknown>, textModel, imageModel, audience, options,
        })
        .returning({ id: schema.comics.id }),
    );
    await claimBusy(ws, comic.id, "adapt");
    await log("comic.created", { comicId: comic.id, chars: story.length, pages, format, style: style.name, textModel, imageModel, audience, dialogue, review, cast: cast.length });
    await inngest.send(comicAdaptRequested.create({ comicId: comic.id, organizationId: ws.organizationId, requestedBy: ws.userId }));
    target = comicPath(comic.id);
    return review ? "Đã tạo truyện; Claude đang viết kịch bản…" : "Đã tạo truyện; viết kịch bản rồi vẽ luôn…";
  });
  if (target) redirect(target);
  return state;
}

/** Runs `fn` on a comic of the workspace (with its row loaded), then refreshes its page. */
async function onComic(fd: FormData, fn: (w: Awaited<ReturnType<typeof writer>>, comicId: string) => Promise<string>) {
  return run(async () => {
    const w = await writer();
    const comicId = str(fd, "comicId");
    const loaded = await loadComic(w.ws, comicId);
    if (!loaded) throw new Error("Không tìm thấy truyện này");
    const message = await fn(w, comicId);
    revalidatePath(`/app/comics/${comicId}`);
    return message;
  });
}

export async function readaptComic(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    await claimBusy(ws, comicId, "adapt");
    await inngest.send(comicAdaptRequested.create({ comicId, organizationId: ws.organizationId, requestedBy: ws.userId }));
    await log("comic.readapt_requested", { comicId });
    return "Đang viết lại toàn bộ kịch bản…";
  });
}

export async function rewritePage(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const pageId = str(fd, "pageId");
    const instruction = str(fd, "instruction").slice(0, 1000);
    await claimBusy(ws, comicId, "adapt", "Đang viết lại trang…");
    await inngest.send(comicAdaptRequested.create({ comicId, organizationId: ws.organizationId, requestedBy: ws.userId, pageId, instruction }));
    await log("comic.page_rewrite_requested", { comicId, pageId, instruction });
    return "Claude đang viết lại trang…";
  });
}

/** Lettering rows of the panel form: `kind_i`, `speaker_i`, `text_i`. */
function letteringFrom(fd: FormData) {
  const rows: { kind: LetteringKind; speaker: string | null; text: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const text = String(fd.get(`text_${i}`) ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const kind = pick(str(fd, `kind_${i}`), LETTERING_KINDS, "speech");
    const speaker = kind === "caption" || kind === "sfx" ? null : str(fd, `speaker_${i}`) || null;
    rows.push({ kind, speaker, text: text.slice(0, 300) });
  }
  return rows;
}

export async function savePanel(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const panelId = str(fd, "panelId");
    const edit = {
      description: str(fd, "description").slice(0, 2000),
      size: pick<PanelSize>(str(fd, "size"), PANEL_SIZES, "medium"),
      shot: pick<Shot>(str(fd, "shot"), SHOTS, "medium"),
      lettering: letteringFrom(fd),
    };
    await updateDoc(ws, comicId, "edit", (doc) => ({ doc: editPanel(doc, panelId, edit), changes: { panel: panelId, edited: true } }));
    await log("comic.panel_edited", { comicId, panelId, lines: edit.lettering.length, size: edit.size });
    return "Đã lưu khung";
  });
}

export async function removePanel(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const panelId = str(fd, "panelId");
    await updateDoc(ws, comicId, "edit", (doc) => ({ doc: deletePanel(doc, panelId), changes: { deletedPanel: panelId } }));
    await log("comic.panel_deleted", { comicId, panelId });
    return "Đã xoá khung";
  });
}

export async function appendPanel(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const pageId = str(fd, "pageId");
    const description = str(fd, "description").slice(0, 2000);
    if (!description) throw new Error("Mô tả khung mới (tiếng Anh, điều hình vẽ cho thấy)");
    await updateDoc(ws, comicId, "edit", (doc) => ({ doc: addPanel(doc, pageId, description), changes: { addedPanelTo: pageId } }));
    await log("comic.panel_added", { comicId, pageId });
    return "Đã thêm khung";
  });
}

export async function removePage(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const pageId = str(fd, "pageId");
    await updateDoc(ws, comicId, "edit", (doc) => {
      if (doc.pages.length <= 1) throw new Error("Truyện cần ít nhất một trang");
      return { doc: deletePage(doc, pageId), changes: { deletedPage: pageId } };
    });
    await log("comic.page_deleted", { comicId, pageId });
    return "Đã xoá trang";
  });
}

export async function changeLayout(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const pageId = str(fd, "pageId");
    const layout = pick<PageLayout>(str(fd, "layout"), PAGE_LAYOUTS, "auto");
    await updateDoc(ws, comicId, "edit", (doc) => ({ doc: setPageLayout(doc, pageId, layout), changes: { pageId, layout } }));
    await log("comic.layout_changed", { comicId, pageId, layout });
    return "Đã đổi bố cục trang";
  });
}

/** Cast review: keep (edit the description), drop or merge a character the adaptation proposed. */
export async function castAction(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const ref = str(fd, "ref");
    const op = str(fd, "op");
    if (op === "drop") {
      await updateDoc(ws, comicId, "edit", (doc) => ({ doc: dropCast(doc, ref), changes: { droppedCast: ref } }));
      await log("comic.cast_dropped", { comicId, ref });
      return "Đã bỏ nhân vật; lời thoại của họ thành lời dẫn";
    }
    if (op === "merge") {
      const into = str(fd, "into");
      await updateDoc(ws, comicId, "edit", (doc) => ({ doc: mergeCast(doc, ref, into), changes: { mergedCast: ref, into } }));
      await log("comic.cast_merged", { comicId, ref, into });
      return "Đã gộp nhân vật";
    }
    const edit = { name: str(fd, "name").slice(0, 80), role: str(fd, "role").slice(0, 200), visual: str(fd, "visual").slice(0, 1000), personality: str(fd, "personality").slice(0, 500) };
    if (!edit.name) throw new Error("Nhân vật cần có tên");
    await updateDoc(ws, comicId, "edit", (doc) => ({ doc: editCast(doc, ref, edit), changes: { editedCast: ref } }));
    // A library character keeps the same description for the next comics.
    const member = (await loadComic(ws, comicId))?.version?.doc.cast.find((c) => c.ref === ref);
    if (member?.characterId)
      await withOrgContext(ws, (tx) => tx.update(schema.comicCharacters).set(edit).where(and(eq(schema.comicCharacters.id, member.characterId!), eq(schema.comicCharacters.organizationId, ws.organizationId))));
    await log("comic.cast_edited", { comicId, ref });
    return "Đã lưu nhân vật";
  });
}

/** "Duyệt & vẽ": the script is final, new characters join the library, the sheets and panels are drawn. */
export async function approveAndDraw(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const access = await comicDrawAccess(ws.userId);
    if (!access.ok) throw new Error(access.reason);
    const { newCharacters } = await approveScript(ws, comicId);
    await claimBusy(ws, comicId, "draw");
    await inngest.send(comicDrawRequested.create({ comicId, organizationId: ws.organizationId, requestedBy: ws.userId }));
    await log("comic.script_approved", { comicId, newCharacters });
    return "Đã duyệt kịch bản; đang vẽ bản mẫu nhân vật và các khung…";
  });
}

export async function drawPanels(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const access = await comicDrawAccess(ws.userId);
    if (!access.ok) throw new Error(access.reason);
    const panelId = str(fd, "panelId");
    const instruction = str(fd, "instruction").slice(0, 1000) || undefined;
    await claimBusy(ws, comicId, "draw", panelId ? "Đang vẽ lại khung…" : undefined);
    await inngest.send(comicDrawRequested.create({ comicId, organizationId: ws.organizationId, requestedBy: ws.userId, ...(panelId ? { panelIds: [panelId], instruction } : {}) }));
    await log("comic.draw_requested", { comicId, panelId: panelId || null, instruction: instruction ?? null });
    return panelId ? "Đang vẽ lại khung…" : "Đang vẽ các khung còn thiếu…";
  });
}

export async function drawSheets(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const access = await comicDrawAccess(ws.userId);
    if (!access.ok) throw new Error(access.reason);
    const ref = str(fd, "ref");
    const instruction = str(fd, "instruction").slice(0, 1000) || undefined;
    await claimBusy(ws, comicId, "cast", "Đang vẽ bản mẫu…");
    await inngest.send(comicCastRequested.create({ comicId, organizationId: ws.organizationId, requestedBy: ws.userId, ...(ref ? { refs: [ref], instruction } : {}) }));
    await log("comic.sheets_requested", { comicId, ref: ref || null, instruction: instruction ?? null });
    return ref ? "Đang vẽ lại bản mẫu…" : "Đang vẽ các bản mẫu còn thiếu…";
  });
}

/** Accepting a sheet makes it the character's reference in this style for every later comic. */
export async function acceptSheet(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const imageId = str(fd, "imageId");
    await withOrgContext(ws, async (tx) => {
      const img = await tx.query.comicImages.findFirst({ where: and(eq(schema.comicImages.id, imageId), eq(schema.comicImages.organizationId, ws.organizationId), eq(schema.comicImages.kind, "sheet")) });
      if (!img?.characterId) throw new Error("Không tìm thấy bản mẫu");
      await tx
        .update(schema.comicImages)
        .set({ status: "draft" })
        .where(and(eq(schema.comicImages.kind, "sheet"), eq(schema.comicImages.characterId, img.characterId), img.styleId ? eq(schema.comicImages.styleId, img.styleId) : isNull(schema.comicImages.styleId), eq(schema.comicImages.status, "accepted")));
      await tx.update(schema.comicImages).set({ status: "accepted" }).where(eq(schema.comicImages.id, imageId));
    });
    await log("comic.sheet_accepted", { comicId, imageId });
    return "Đã duyệt bản mẫu";
  });
}

export async function exportPng(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    const loaded = await loadComic(ws, comicId);
    if (!loaded?.version) throw new Error("Truyện chưa có trang nào");
    await claimBusy(ws, comicId, "export", "Đang xuất trang…");
    try {
      const [exp] = await withOrgContext(ws, (tx) =>
        tx.insert(schema.comicExports).values({ organizationId: ws.organizationId, comicId, versionId: loaded.version!.id, kind: "png", createdBy: ws.userId }).returning({ id: schema.comicExports.id }),
      );
      await inngest.send(comicExportRequested.create({ comicId, organizationId: ws.organizationId, requestedBy: ws.userId, exportId: exp.id }));
      await log("comic.export_requested", { comicId, exportId: exp.id, kind: "png", versionId: loaded.version.id });
    } catch (e) {
      await clearBusy(ws, comicId, (e as Error).message);
      throw e;
    }
    return "Đang xuất các trang thành PNG…";
  });
}

/** Clears a busy flag that went stale (a job that died without reporting), so the comic can be worked on again. */
export async function unstickComic(_: ActionState, fd: FormData) {
  return onComic(fd, async ({ ws, log }, comicId) => {
    await clearBusy(ws, comicId, "Đã dừng bước đang chạy");
    await log("comic.busy_cleared", { comicId });
    return "Đã dừng";
  });
}

export async function deleteComic(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const state = await run(async () => {
    const { ws, log } = await writer();
    const comicId = str(fd, "comicId");
    const [row] = await withOrgContext(ws, (tx) => tx.delete(schema.comics).where(and(eq(schema.comics.id, comicId), eq(schema.comics.organizationId, ws.organizationId))).returning({ title: schema.comics.title }));
    if (!row) throw new Error("Không tìm thấy truyện này");
    await log("comic.deleted", { comicId, title: row.title });
    done = true;
    return "Đã xoá truyện";
  });
  if (done) redirect("/app/comics");
  return state;
}
