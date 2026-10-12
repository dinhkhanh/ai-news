"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { COMIC_FONTS, type ComicFont } from "@ai-news/video/comic";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { run, str, type ActionState } from "@/lib/admin";
import { sheetRequest } from "@/lib/comic/drawing";
import { drawComicImage } from "@/lib/comic/images";
import { acceptSheetImage, checkUpload, loadStyle, MAX_REFS, newUploadKey, snapshotOf, UPLOAD_MAX_BYTES, UPLOAD_TYPES, type UploadType } from "@/lib/comic/library";
import { DEFAULT_IMAGE_MODEL, isImageModel } from "@/lib/comic/models";
import { stylePreviewPrompt } from "@/lib/comic/prompts";
import { comicDrawAccess } from "@/lib/comic/service";
import { flagEnabled } from "@/lib/flags";
import { presignPut } from "@/lib/r2";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * Style and character libraries (docs/COMIC.md §6, M2): `/app/comics/styles` and `/app/comics/characters`. Any
 * workspace writer, flag `comics` on. Presets (organization_id null) are read-only: they can be copied into the
 * workspace. A test drawing or a sheet drawn here runs in the request (one picture, ~10–20 s).
 */

async function writer() {
  const w = await assertWorkspaceWriter();
  if (!(await flagEnabled("comics"))) throw new Error("Truyện tranh đang tắt (cờ comics trong /admin/integrations)");
  return w;
}

const STYLES = "/app/comics/styles";
const CHARACTERS = "/app/comics/characters";
const SWATCH = /^#[0-9a-f]{6}$/i;

async function ownStyle(ws: { organizationId: string; userId: string }, id: string) {
  const style = await withOrgContext(ws, (tx) => tx.query.comicStyles.findFirst({ where: and(eq(schema.comicStyles.id, id), eq(schema.comicStyles.organizationId, ws.organizationId)) }));
  if (!style) throw new Error("Không tìm thấy phong cách này trong workspace (phong cách mẫu chỉ nhân bản được)");
  return style;
}

async function ownCharacter(ws: { organizationId: string; userId: string }, id: string) {
  const c = await withOrgContext(ws, (tx) => tx.query.comicCharacters.findFirst({ where: and(eq(schema.comicCharacters.id, id), eq(schema.comicCharacters.organizationId, ws.organizationId)) }));
  if (!c) throw new Error("Không tìm thấy nhân vật này");
  return c;
}

/* ------------------------------------------------------------------ styles */

export async function saveStyle(_: ActionState, fd: FormData): Promise<ActionState> {
  let saved: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await writer();
    const id = str(fd, "id");
    const values = {
      name: str(fd, "name").slice(0, 60),
      prompt: str(fd, "prompt").slice(0, 1000),
      negative: str(fd, "negative").slice(0, 500),
      colourMode: str(fd, "colourMode") === "bw" ? "bw" : "colour",
      storytellingNotes: str(fd, "storytellingNotes").slice(0, 1000),
      font: (Object.keys(COMIC_FONTS) as ComicFont[]).includes(str(fd, "font") as ComicFont) ? str(fd, "font") : "itim",
      readingDirection: str(fd, "readingDirection") === "rtl" ? "rtl" : "ltr",
      swatch: SWATCH.test(str(fd, "swatch")) ? str(fd, "swatch") : "#e4e4e7",
    };
    if (!values.name) throw new Error("Đặt tên cho phong cách");
    if (values.prompt.length < 20) throw new Error("Mô tả phong cách (tiếng Anh) cần ít nhất 20 ký tự: chất liệu, nét, màu, đổ bóng");
    if (id) {
      await ownStyle(ws, id);
      await withOrgContext(ws, (tx) => tx.update(schema.comicStyles).set(values).where(eq(schema.comicStyles.id, id)));
      await log("comic_style.updated", { styleId: id, name: values.name });
      saved = id;
      return "Đã lưu phong cách; truyện tạo sau sẽ dùng bản này";
    }
    const [row] = await withOrgContext(ws, (tx) => tx.insert(schema.comicStyles).values({ ...values, organizationId: ws.organizationId, position: 100, createdBy: ws.userId }).returning({ id: schema.comicStyles.id }));
    await log("comic_style.created", { styleId: row.id, name: values.name });
    saved = row.id;
    return "Đã tạo phong cách";
  });
  if (saved) {
    revalidatePath(STYLES);
    redirect(`${STYLES}?edit=${saved}#editor`);
  }
  return state;
}

/** Copies a preset (or another workspace style) into the workspace, where it can be edited. */
export async function duplicateStyle(_: ActionState, fd: FormData): Promise<ActionState> {
  let saved: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await writer();
    const src = await loadStyle(ws, str(fd, "id"));
    if (!src) throw new Error("Không tìm thấy phong cách");
    const [row] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.comicStyles)
        .values({
          organizationId: ws.organizationId,
          name: `${src.name} (bản sao)`.slice(0, 60),
          prompt: src.prompt,
          negative: src.negative,
          colourMode: src.colourMode,
          storytellingNotes: src.storytellingNotes,
          // A preset has no samples; another workspace style's samples are this workspace's own files.
          referenceKeys: src.organizationId ? src.referenceKeys : [],
          font: src.font,
          readingDirection: src.readingDirection,
          swatch: src.swatch,
          position: 100,
          createdBy: ws.userId,
        })
        .returning({ id: schema.comicStyles.id }),
    );
    await log("comic_style.created", { styleId: row.id, from: src.id, name: src.name });
    saved = row.id;
    return "Đã nhân bản; sửa bản này cho workspace";
  });
  if (saved) {
    revalidatePath(STYLES);
    redirect(`${STYLES}?edit=${saved}#editor`);
  }
  return state;
}

/** A style comics still point at stays: their snapshot keeps working, but the row also holds its sheets and samples. */
export async function deleteStyle(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await writer();
    const style = await ownStyle(ws, str(fd, "id"));
    const [{ n }] = await withOrgContext(ws, (tx) => tx.select({ n: count() }).from(schema.comics).where(eq(schema.comics.styleId, style.id)));
    if (n > 0) throw new Error(`Có ${n} truyện đang dùng phong cách này: không xoá được`);
    await withOrgContext(ws, (tx) => tx.delete(schema.comicStyles).where(eq(schema.comicStyles.id, style.id)));
    await log("comic_style.deleted", { styleId: style.id, name: style.name });
    return "Đã xoá phong cách";
  });
  if (state.ok) revalidatePath(STYLES);
  return state;
}

/** "Vẽ thử": the fixed test scene in this style, so styles can be compared side by side. */
export async function drawStyleSample(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await writer();
    const style = await loadStyle(ws, str(fd, "id"));
    if (!style) throw new Error("Không tìm thấy phong cách");
    const access = await comicDrawAccess(ws.userId);
    if (!access.ok) throw new Error(access.reason);
    const modelId = isImageModel(str(fd, "imageModel")) ? str(fd, "imageModel") : DEFAULT_IMAGE_MODEL;
    const snap = snapshotOf(style);
    const img = await drawComicImage(ws, { kind: "sample", modelId, prompt: stylePreviewPrompt(snap), refKeys: snap.referenceKeys.slice(0, MAX_REFS), aspect: "3:4", projectId: access.projectId, styleId: style.id });
    await log("comic_style.sample_drawn", { styleId: style.id, imageId: img.id, model: modelId, costUsd: img.costUsd });
    return `Đã vẽ thử (${modelId}, $${img.costUsd.toFixed(3)})`;
  });
  revalidatePath(STYLES);
  return state;
}

/* -------------------------------------------------------------- characters */

export async function saveCharacter(_: ActionState, fd: FormData): Promise<ActionState> {
  let saved: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await writer();
    const id = str(fd, "id");
    const values = { name: str(fd, "name").slice(0, 80), role: str(fd, "role").slice(0, 200), visual: str(fd, "visual").slice(0, 1000), personality: str(fd, "personality").slice(0, 500) };
    if (!values.name) throw new Error("Nhân vật cần có tên");
    if (values.visual.length < 15) throw new Error("Tả ngoại hình (tiếng Anh) cho mô hình vẽ: tuổi, dáng, tóc, trang phục và màu, một món đồ riêng");
    if (id) {
      await ownCharacter(ws, id);
      await withOrgContext(ws, (tx) => tx.update(schema.comicCharacters).set(values).where(eq(schema.comicCharacters.id, id)));
      await log("comic_character.updated", { characterId: id, name: values.name });
      saved = id;
      return "Đã lưu nhân vật; truyện tạo sau sẽ dùng mô tả này";
    }
    const [row] = await withOrgContext(ws, (tx) => tx.insert(schema.comicCharacters).values({ ...values, organizationId: ws.organizationId, createdBy: ws.userId }).returning({ id: schema.comicCharacters.id }));
    await log("comic_character.created", { characterId: row.id, name: values.name });
    saved = row.id;
    return "Đã tạo nhân vật";
  });
  if (saved) {
    revalidatePath(CHARACTERS);
    redirect(`${CHARACTERS}?edit=${saved}#editor`);
  }
  return state;
}

/** Deleting a character removes its sheets; comics keep their copy of the cast and the panels already drawn. */
export async function deleteCharacter(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await writer();
    const c = await ownCharacter(ws, str(fd, "id"));
    await withOrgContext(ws, (tx) => tx.delete(schema.comicCharacters).where(eq(schema.comicCharacters.id, c.id)));
    await log("comic_character.deleted", { characterId: c.id, name: c.name });
    return "Đã xoá nhân vật";
  });
  if (state.ok) revalidatePath(CHARACTERS);
  return state;
}

/** A sheet of the character in one style, drawn now (a draft until accepted). */
export async function drawCharacterSheet(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await writer();
    const c = await ownCharacter(ws, str(fd, "id"));
    const style = await loadStyle(ws, str(fd, "styleId"));
    if (!style) throw new Error("Chọn một phong cách");
    const access = await comicDrawAccess(ws.userId);
    if (!access.ok) throw new Error(access.reason);
    const modelId = isImageModel(str(fd, "imageModel")) ? str(fd, "imageModel") : DEFAULT_IMAGE_MODEL;
    const instruction = str(fd, "instruction").slice(0, 1000) || null;
    const req = sheetRequest(c, snapshotOf(style), c.referenceKeys, modelId, instruction);
    const img = await drawComicImage(ws, { kind: "sheet", modelId, prompt: req.prompt, refKeys: req.refKeys, aspect: req.aspect, projectId: access.projectId, characterId: c.id, styleId: style.id, instruction });
    await log("comic_character.sheet_drawn", { characterId: c.id, styleId: style.id, imageId: img.id, model: modelId, costUsd: img.costUsd });
    return `Đã vẽ bản mẫu “${style.name}”: duyệt nếu ưng`;
  });
  revalidatePath(CHARACTERS);
  return state;
}

export async function acceptCharacterSheet(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await writer();
    const img = await acceptSheetImage(ws, str(fd, "imageId"));
    await log("comic_character.sheet_accepted", { characterId: img.characterId, styleId: img.styleId, imageId: img.id });
    return "Đã duyệt bản mẫu: truyện sau dùng hình này";
  });
  revalidatePath(CHARACTERS);
  return state;
}

/* ----------------------------------------------------------------- uploads */

export type UploadTarget = { target: "style" | "character" } | { target: "sheet"; styleId: string };
const targetSchema = z.union([z.object({ target: z.enum(["style", "character"]), id: z.string().uuid() }), z.object({ target: z.literal("sheet"), id: z.string().uuid(), styleId: z.string().uuid() })]);
export type UploadTicket = { ok: true; key: string; url: string } | { ok: false; message: string };
export type UploadSaved = { ok: true; message: string } | { ok: false; message: string };
const fail = (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : "Có lỗi xảy ra" });

async function owner(ws: { organizationId: string; userId: string }, t: UploadTarget & { id: string }) {
  if (t.target === "style") return { refs: (await ownStyle(ws, t.id)).referenceKeys };
  const c = await ownCharacter(ws, t.id);
  if (t.target === "sheet" && !(await loadStyle(ws, t.styleId))) throw new Error("Không tìm thấy phong cách");
  return { refs: c.referenceKeys };
}

/** Presigned PUT, browser → R2 (pictures are often larger than a server action body may be). */
export async function createLibraryUpload(input: UploadTarget & { id: string; contentType: string; sizeBytes: number }): Promise<UploadTicket> {
  try {
    const { ws } = await writer();
    targetSchema.parse(input);
    if (!(input.contentType in UPLOAD_TYPES)) throw new Error("Chỉ nhận ảnh PNG, JPEG hoặc WebP");
    if (!(input.sizeBytes > 0) || input.sizeBytes > UPLOAD_MAX_BYTES) throw new Error("Ảnh tối đa 10 MB");
    const { refs } = await owner(ws, input);
    if (input.target !== "sheet" && refs.length >= MAX_REFS) throw new Error(`Tối đa ${MAX_REFS} ảnh tham chiếu: bỏ bớt một ảnh trước`);
    const key = newUploadKey(ws.organizationId, input.contentType as UploadType);
    return { ok: true, key, url: await presignPut(key, input.contentType, 900) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * After the PUT: a style or character gains a reference image; a sheet upload becomes the character's accepted sheet
 * in that style ("tải bản mẫu của bạn"), as if it had been drawn and accepted.
 */
export async function registerLibraryUpload(input: UploadTarget & { id: string; key: string }): Promise<UploadSaved> {
  try {
    const { ws, log } = await writer();
    targetSchema.parse(input);
    const { refs } = await owner(ws, input);
    const size = await checkUpload(ws, input.key);
    if (input.target !== "sheet") {
      if (refs.includes(input.key)) return { ok: true, message: "Ảnh đã có" };
      if (refs.length >= MAX_REFS) throw new Error(`Tối đa ${MAX_REFS} ảnh tham chiếu`);
      const referenceKeys = [...refs, input.key];
      await withOrgContext(ws, (tx) =>
        input.target === "style"
          ? tx.update(schema.comicStyles).set({ referenceKeys }).where(eq(schema.comicStyles.id, input.id))
          : tx.update(schema.comicCharacters).set({ referenceKeys }).where(eq(schema.comicCharacters.id, input.id)),
      );
      await log(input.target === "style" ? "comic_style.reference_added" : "comic_character.reference_added", { id: input.id, key: input.key, ...size });
      revalidatePath(input.target === "style" ? STYLES : CHARACTERS);
      return { ok: true, message: "Đã thêm ảnh tham chiếu" };
    }
    const [row] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.comicImages)
        .values({ organizationId: ws.organizationId, kind: "sheet", characterId: input.id, styleId: input.styleId, status: "draft", imageKey: input.key, width: size.width, height: size.height, model: "upload", prompt: "", costUsd: "0", meta: { uploaded: true }, createdBy: ws.userId })
        .returning({ id: schema.comicImages.id }),
    );
    await acceptSheetImage(ws, row.id);
    await log("comic_character.sheet_uploaded", { characterId: input.id, styleId: input.styleId, imageId: row.id, ...size });
    revalidatePath(CHARACTERS);
    return { ok: true, message: "Đã dùng ảnh của bạn làm bản mẫu" };
  } catch (e) {
    return fail(e);
  }
}

/** Takes a reference image off a style or character. The file stays: comics' style snapshots may still send it. */
export async function removeLibraryReference(input: { target: "style" | "character"; id: string; key: string }): Promise<UploadSaved> {
  try {
    const { ws, log } = await writer();
    targetSchema.parse(input);
    const { refs } = await owner(ws, input);
    const referenceKeys = refs.filter((k) => k !== input.key);
    await withOrgContext(ws, (tx) =>
      input.target === "style"
        ? tx.update(schema.comicStyles).set({ referenceKeys }).where(eq(schema.comicStyles.id, input.id))
        : tx.update(schema.comicCharacters).set({ referenceKeys }).where(eq(schema.comicCharacters.id, input.id)),
    );
    await log(input.target === "style" ? "comic_style.reference_removed" : "comic_character.reference_removed", { id: input.id, key: input.key });
    revalidatePath(input.target === "style" ? STYLES : CHARACTERS);
    return { ok: true, message: "Đã bỏ ảnh" };
  } catch (e) {
    return fail(e);
  }
}
