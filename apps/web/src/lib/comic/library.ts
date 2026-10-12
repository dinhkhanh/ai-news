import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { imageSize } from "image-size";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { deleteObject, getObjectBuffer, headObject, r2Key } from "@/lib/r2";
import type { ComicStyle } from "./prompts";
import type { Ctx } from "./service";

/**
 * Style and character libraries (docs/COMIC.md §6, M2): reference images uploaded by members, character sheets they
 * drew themselves, style samples. Uploads go browser → R2 with a presigned PUT under `library/comics/<org>/uploads/`
 * and are checked here before anything points at them.
 */

/** Reference images per style or character (sent with every drawing, so the model's limit matters: 4 keeps room for the rest). */
export const MAX_REFS = 4;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type UploadType = keyof typeof UPLOAD_TYPES;

export const uploadPrefix = (organizationId: string) => r2Key.comicLibrary(organizationId, "uploads/");
export const newUploadKey = (organizationId: string, contentType: UploadType) => `${uploadPrefix(organizationId)}${randomUUID()}.${UPLOAD_TYPES[contentType]}`;

/**
 * After the browser's PUT: the key must be this workspace's upload, the file an image of at least 256 px on its short
 * side and at most 10 MB. A file that fails is deleted again.
 */
export async function checkUpload(ctx: Ctx, key: string) {
  if (!key.startsWith(uploadPrefix(ctx.organizationId)) || !/\.(png|jpg|webp)$/.test(key)) throw new Error("Khoá tệp không hợp lệ");
  const head = await headObject(key);
  if (!head.exists || head.size === 0) throw new Error("Tệp chưa được tải lên xong");
  const reject = async (message: string) => {
    await deleteObject(key).catch(() => {});
    return new Error(message);
  };
  if (head.size > UPLOAD_MAX_BYTES) throw await reject("Ảnh tối đa 10 MB");
  let size: { width?: number; height?: number; type?: string };
  try {
    size = imageSize(await getObjectBuffer(key));
  } catch {
    throw await reject("Tệp không phải ảnh PNG, JPEG hay WebP");
  }
  if (!size.width || !size.height || !["png", "jpg", "webp"].includes(size.type ?? "")) throw await reject("Tệp không phải ảnh PNG, JPEG hay WebP");
  if (Math.min(size.width, size.height) < 256) throw await reject(`Ảnh quá nhỏ (${size.width}×${size.height}): cạnh ngắn cần ít nhất 256 px`);
  return { width: size.width, height: size.height };
}

/** A style of the workspace or a platform preset, as a comic would snapshot it. */
export async function loadStyle(ctx: Ctx, styleId: string) {
  return withOrgContext(ctx, (tx) =>
    tx.query.comicStyles.findFirst({ where: and(eq(schema.comicStyles.id, styleId), or(isNull(schema.comicStyles.organizationId), eq(schema.comicStyles.organizationId, ctx.organizationId))) }),
  );
}

export const snapshotOf = (style: typeof schema.comicStyles.$inferSelect): ComicStyle => ({
  id: style.id,
  name: style.name,
  prompt: style.prompt,
  negative: style.negative,
  colourMode: style.colourMode === "bw" ? "bw" : "colour",
  storytellingNotes: style.storytellingNotes,
  referenceKeys: style.referenceKeys,
});

/** Makes one sheet the character's reference in its style (one accepted sheet per character × style). */
export async function acceptSheetImage(ctx: Ctx, imageId: string) {
  return withOrgContext(ctx, async (tx) => {
    const img = await tx.query.comicImages.findFirst({ where: and(eq(schema.comicImages.id, imageId), eq(schema.comicImages.organizationId, ctx.organizationId), eq(schema.comicImages.kind, "sheet")) });
    if (!img?.characterId) throw new Error("Không tìm thấy bản mẫu");
    await tx
      .update(schema.comicImages)
      .set({ status: "draft" })
      .where(
        and(
          eq(schema.comicImages.kind, "sheet"),
          eq(schema.comicImages.characterId, img.characterId),
          img.styleId ? eq(schema.comicImages.styleId, img.styleId) : isNull(schema.comicImages.styleId),
          eq(schema.comicImages.status, "accepted"),
        ),
      );
    await tx.update(schema.comicImages).set({ status: "accepted" }).where(eq(schema.comicImages.id, imageId));
    return img;
  });
}

/** The latest style samples ("Vẽ thử") per style, newest first. */
export async function latestSamples(ctx: Ctx, styleIds: string[], perStyle = 3) {
  const out = new Map<string, { id: string; key: string; model: string; createdAt: Date }[]>();
  if (!styleIds.length) return out;
  const rows = await withOrgContext(ctx, (tx) =>
    tx
      .select({ id: schema.comicImages.id, styleId: schema.comicImages.styleId, key: schema.comicImages.imageKey, model: schema.comicImages.model, createdAt: schema.comicImages.createdAt })
      .from(schema.comicImages)
      .where(and(eq(schema.comicImages.kind, "sample"), eq(schema.comicImages.organizationId, ctx.organizationId), inArray(schema.comicImages.styleId, styleIds)))
      .orderBy(desc(schema.comicImages.createdAt))
      .limit(styleIds.length * perStyle * 4),
  );
  for (const r of rows) {
    if (!r.styleId) continue;
    const list = out.get(r.styleId) ?? [];
    if (list.length < perStyle) list.push({ id: r.id, key: r.key, model: r.model, createdAt: r.createdAt });
    out.set(r.styleId, list);
  }
  return out;
}

/** Every sheet of some characters, newest first (the library shows them per style). */
export async function sheetsOfCharacters(ctx: Ctx, characterIds: string[]) {
  if (!characterIds.length) return [];
  return withOrgContext(ctx, (tx) =>
    tx
      .select({ id: schema.comicImages.id, characterId: schema.comicImages.characterId, styleId: schema.comicImages.styleId, status: schema.comicImages.status, key: schema.comicImages.imageKey, model: schema.comicImages.model, createdAt: schema.comicImages.createdAt })
      .from(schema.comicImages)
      .where(and(eq(schema.comicImages.kind, "sheet"), eq(schema.comicImages.organizationId, ctx.organizationId), inArray(schema.comicImages.characterId, characterIds)))
      .orderBy(desc(schema.comicImages.createdAt)),
  );
}
