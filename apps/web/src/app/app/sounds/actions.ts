"use server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "@/db";
import { withOrgContext, type Tx } from "@/db/context";
import { deleteObject, getObjectRange, headObject, presignPut, putObject } from "@/lib/r2";
import { collectionActor, itemView } from "@/lib/media/sound-collections";
import {
  AUDIO_EXT,
  audioContentType,
  canEditCollection,
  canManageCollection,
  COLLECTION_COLOURS,
  collectionName,
  isSoundKind,
  parseSoundSearch,
  PIXABAY_LICENCE_URL,
  pixabayMusicPage,
  sniffAudio,
  SOUND_MAX_BYTES,
  titleFromPixabayPage,
  type CollectionItemView,
  type SoundKind,
} from "@/lib/media/sound-library";
import { downloadSound, openverseAudio, searchOpenverse, type SoundSearchPage } from "@/lib/media/sound-search";
import { assertWorkspaceWriter, getWorkspace } from "@/lib/workspace";

/**
 * Sound library (/app/sounds). Anyone in the workspace searches and plays; writers keep collections: a private one
 * belongs to its creator, a shared one takes sounds from every writer and is managed by its creator or a workspace
 * admin (`canEditCollection` / `canManageCollection`). Added sounds are copied to R2 under `library/sounds/<org>/`
 * and never deleted there, because timeline versions that used one keep its key.
 */

type Fail = { ok: false; message: string };
const fail = (e: unknown): Fail => ({ ok: false, message: e instanceof Error ? e.message : "Có lỗi xảy ra" });
const soundKey = (org: string, name: string) => `library/sounds/${org}/${name}`;
const MAX_ADD = 10;

export async function searchSounds(input: Record<string, unknown>): Promise<({ ok: true } & SoundSearchPage) | Fail> {
  try {
    const ws = await getWorkspace();
    if (!ws) throw new Error("Chưa đăng nhập");
    const f = parseSoundSearch(input);
    return { ok: true, ...(await searchOpenverse(f)) };
  } catch (e) {
    return fail(e);
  }
}

async function loadCollection(tx: Tx, organizationId: string, id: string) {
  const c = await tx.query.soundCollections.findFirst({ where: and(eq(schema.soundCollections.id, id), eq(schema.soundCollections.organizationId, organizationId)) });
  if (!c) throw new Error("Không tìm thấy bộ sưu tập");
  return c;
}

export async function createCollection(input: { name: string; shared: boolean }): Promise<{ ok: true; id: string; message: string } | Fail> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const name = collectionName(input.name ?? "");
    if (!name) throw new Error("Đặt tên cho bộ sưu tập");
    const shared = input.shared !== false;
    const row = await withOrgContext(ws, async (tx) => {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.soundCollections).where(eq(schema.soundCollections.organizationId, ws.organizationId));
      const [row] = await tx
        .insert(schema.soundCollections)
        .values({ organizationId: ws.organizationId, name, shared, colour: COLLECTION_COLOURS[n % COLLECTION_COLOURS.length], createdBy: ws.userId })
        .returning({ id: schema.soundCollections.id });
      return row;
    });
    await log("sound_collection.created", { collectionId: row.id, name, shared });
    revalidatePath("/app/sounds");
    return { ok: true, id: row.id, message: `Đã tạo «${name}»` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateCollection(input: { id: string; name?: string; shared?: boolean }): Promise<{ ok: true; message: string } | Fail> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const name = input.name !== undefined ? collectionName(input.name) : undefined;
    if (name === "") throw new Error("Đặt tên cho bộ sưu tập");
    const c = await withOrgContext(ws, async (tx) => {
      const c = await loadCollection(tx, ws.organizationId, input.id);
      if (!canManageCollection(c, collectionActor(ws))) throw new Error("Chỉ người tạo (hoặc admin workspace, với bộ sưu tập chung) được đổi bộ sưu tập này");
      await tx
        .update(schema.soundCollections)
        .set({ ...(name !== undefined ? { name } : {}), ...(typeof input.shared === "boolean" ? { shared: input.shared } : {}) })
        .where(eq(schema.soundCollections.id, c.id));
      return c;
    });
    await log("sound_collection.updated", { collectionId: c.id, name: name ?? c.name, shared: input.shared ?? c.shared });
    revalidatePath("/app/sounds");
    return { ok: true, message: typeof input.shared === "boolean" ? (input.shared ? "Đã chia sẻ với workspace" : "Chỉ mình bạn thấy bộ sưu tập này") : "Đã đổi tên" };
  } catch (e) {
    return fail(e);
  }
}

/** Delete a collection and its rows. The R2 copies stay: saved video versions may still play them. */
export async function deleteCollection(input: { id: string }): Promise<{ ok: true; message: string } | Fail> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const c = await withOrgContext(ws, async (tx) => {
      const c = await loadCollection(tx, ws.organizationId, input.id);
      if (!canManageCollection(c, collectionActor(ws))) throw new Error("Chỉ người tạo (hoặc admin workspace, với bộ sưu tập chung) được xoá bộ sưu tập này");
      await tx.delete(schema.soundCollections).where(eq(schema.soundCollections.id, c.id));
      return c;
    });
    await log("sound_collection.deleted", { collectionId: c.id, name: c.name });
    revalidatePath("/app/sounds");
    return { ok: true, message: `Đã xoá «${c.name}»` };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Add Openverse results to a collection by id (at most 10 per call). Each one is re-read from Openverse (nothing
 * from the browser is stored) and its file copied to R2, or the copy another collection of the workspace already
 * holds is reused.
 */
export async function addSounds(input: { collectionId: string; ids: string[] }): Promise<{ ok: true; message: string; items: CollectionItemView[]; failed: string[] } | Fail> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const ids = [...new Set((input.ids ?? []).filter((x) => typeof x === "string"))].slice(0, MAX_ADD);
    if (!ids.length) throw new Error("Chọn ít nhất một âm thanh");
    const { c, have, known } = await withOrgContext(ws, async (tx) => {
      const c = await loadCollection(tx, ws.organizationId, input.collectionId);
      if (!canEditCollection(c, collectionActor(ws))) throw new Error("Bộ sưu tập riêng của người khác: chỉ người tạo được thêm");
      const rows = await tx
        .select()
        .from(schema.soundCollectionItems)
        .where(and(eq(schema.soundCollectionItems.organizationId, ws.organizationId), eq(schema.soundCollectionItems.provider, "openverse"), isNotNull(schema.soundCollectionItems.providerId), inArray(schema.soundCollectionItems.providerId, ids)));
      return { c, have: new Set(rows.filter((r) => r.collectionId === c.id).map((r) => r.providerId!)), known: new Map(rows.map((r) => [r.providerId!, r])) };
    });
    const added: CollectionItemView[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      if (have.has(id)) continue;
      try {
        const prev = known.get(id);
        let values: Omit<typeof schema.soundCollectionItems.$inferInsert, "collectionId" | "organizationId" | "position" | "addedBy">;
        if (prev) {
          values = { provider: "openverse", providerId: id, source: prev.source, title: prev.title, creator: prev.creator, creatorUrl: prev.creatorUrl, landingUrl: prev.landingUrl, licence: prev.licence, licenceVersion: prev.licenceVersion, licenceUrl: prev.licenceUrl, kind: prev.kind, durationSec: prev.durationSec, r2Path: prev.r2Path, mime: prev.mime, sizeBytes: prev.sizeBytes };
        } else {
          const r = await openverseAudio(id);
          const dl = await downloadSound(r.audioUrl);
          const key = soundKey(ws.organizationId, `${nanoid(12)}.${AUDIO_EXT[dl.contentType] ?? "mp3"}`);
          await putObject(key, dl.body, dl.contentType);
          values = { provider: "openverse", providerId: id, source: r.source, title: r.title, creator: r.creator, creatorUrl: r.creatorUrl, landingUrl: r.landingUrl, licence: r.licence, licenceVersion: r.licenceVersion, licenceUrl: r.licenceUrl, kind: r.kind, durationSec: r.durationSec != null ? r.durationSec.toFixed(2) : null, r2Path: key, mime: dl.contentType, sizeBytes: dl.body.length };
        }
        const row = await withOrgContext(ws, async (tx) => {
          const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${schema.soundCollectionItems.position}) + 1, 0)::int` }).from(schema.soundCollectionItems).where(eq(schema.soundCollectionItems.collectionId, c.id));
          const [row] = await tx
            .insert(schema.soundCollectionItems)
            .values({ ...values, organizationId: ws.organizationId, collectionId: c.id, position: next, addedBy: ws.userId })
            .onConflictDoNothing()
            .returning();
          return row;
        });
        if (row) added.push(itemView(row));
      } catch (e) {
        failed.push(`${id}: ${e instanceof Error ? e.message : "lỗi"}`);
      }
    }
    if (added.length) await log("sound_collection.sounds_added", { collectionId: c.id, name: c.name, providerIds: added.map((a) => a.providerId), titles: added.map((a) => a.title), failed: failed.length });
    revalidatePath("/app/sounds");
    if (!added.length && failed.length) throw new Error(`Không thêm được: ${failed[0].split(": ").slice(1).join(": ")}`);
    const message = added.length ? `Đã thêm ${added.length} âm thanh vào «${c.name}»${failed.length ? ` · ${failed.length} lỗi` : ""}` : `Đã có sẵn trong «${c.name}»`;
    return { ok: true, message, items: added, failed };
  } catch (e) {
    return fail(e);
  }
}

export async function removeSound(input: { itemId: string }): Promise<{ ok: true; message: string } | Fail> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const { item, c } = await withOrgContext(ws, async (tx) => {
      const item = await tx.query.soundCollectionItems.findFirst({ where: and(eq(schema.soundCollectionItems.id, input.itemId), eq(schema.soundCollectionItems.organizationId, ws.organizationId)) });
      if (!item) throw new Error("Âm thanh không còn trong bộ sưu tập");
      const c = await loadCollection(tx, ws.organizationId, item.collectionId);
      if (!canEditCollection(c, collectionActor(ws))) throw new Error("Bộ sưu tập riêng của người khác: chỉ người tạo được bỏ âm thanh");
      await tx.delete(schema.soundCollectionItems).where(eq(schema.soundCollectionItems.id, item.id));
      return { item, c };
    });
    await log("sound_collection.sound_removed", { collectionId: c.id, itemId: item.id, title: item.title });
    revalidatePath("/app/sounds");
    return { ok: true, message: `Đã bỏ «${item.title}» khỏi «${c.name}»` };
  } catch (e) {
    return fail(e);
  }
}

/** Presigned PUT for a Pixabay download or the member's own file (browser → R2; server actions cap bodies at 3 MB). */
export async function createSoundUpload(input: { collectionId: string; filename: string; contentType: string; sizeBytes: number }): Promise<{ ok: true; key: string; url: string; contentType: string } | Fail> {
  try {
    const { ws } = await assertWorkspaceWriter();
    const contentType = audioContentType(input.filename ?? "", input.contentType);
    if (!contentType) throw new Error("Chỉ nhận MP3, WAV, M4A, OGG hoặc FLAC");
    if (!(input.sizeBytes > 0) || input.sizeBytes > SOUND_MAX_BYTES) throw new Error("Tệp tối đa 25 MB");
    await withOrgContext(ws, async (tx) => {
      const c = await loadCollection(tx, ws.organizationId, input.collectionId);
      if (!canEditCollection(c, collectionActor(ws))) throw new Error("Bộ sưu tập riêng của người khác: chỉ người tạo được thêm");
    });
    const key = soundKey(ws.organizationId, `uploads/${nanoid(12)}.${AUDIO_EXT[contentType]}`);
    return { ok: true, key, url: await presignPut(key, contentType, 900), contentType };
  } catch (e) {
    return fail(e);
  }
}

export type SoundImport = {
  collectionId: string;
  key: string;
  /** `pixabay` needs the track's page URL; `upload` needs `rightsConfirmed`. */
  provider: "pixabay" | "upload";
  pageUrl?: string;
  title?: string;
  creator?: string;
  kind?: SoundKind;
  durationSec?: number | null;
  filename: string;
  rightsConfirmed?: boolean;
};

/** After the browser PUT: check the object really is audio, then add it to the collection. */
export async function registerSoundImport(input: SoundImport): Promise<{ ok: true; message: string; item: CollectionItemView } | Fail> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    if (!input.key?.startsWith(soundKey(ws.organizationId, "uploads/"))) throw new Error("Khoá tệp không hợp lệ");
    const provider = input.provider === "pixabay" ? "pixabay" : "upload";
    const page = provider === "pixabay" ? pixabayMusicPage(input.pageUrl ?? "") : null;
    if (provider === "pixabay" && !page) throw new Error("Dán link trang bài trên Pixabay (pixabay.com/music/…), để giấy phép có nguồn");
    if (provider === "upload" && !input.rightsConfirmed) throw new Error("Xác nhận bạn có quyền dùng tệp này trong video");
    const head = await headObject(input.key);
    if (!head.exists || head.size === 0) throw new Error("Tệp chưa được tải lên xong");
    const sniffed = sniffAudio(await getObjectRange(input.key, 0, 15));
    if (head.size > SOUND_MAX_BYTES || !sniffed) {
      await deleteObject(input.key).catch(() => {});
      throw new Error(head.size > SOUND_MAX_BYTES ? "Tệp tối đa 25 MB" : "Tệp không phải âm thanh MP3, WAV, M4A, OGG hoặc FLAC");
    }
    const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || (page ? titleFromPixabayPage(page) : null) || input.filename.replace(/\.[^.]+$/, "").slice(0, 200) || "Không tên";
    const creator = (input.creator ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const kind: SoundKind = input.kind && isSoundKind(input.kind) ? input.kind : "music";
    const durationSec = typeof input.durationSec === "number" && input.durationSec > 0 && input.durationSec < 6 * 3600 ? input.durationSec.toFixed(2) : null;
    const { row, c } = await withOrgContext(ws, async (tx) => {
      const c = await loadCollection(tx, ws.organizationId, input.collectionId);
      if (!canEditCollection(c, collectionActor(ws))) throw new Error("Bộ sưu tập riêng của người khác: chỉ người tạo được thêm");
      const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${schema.soundCollectionItems.position}) + 1, 0)::int` }).from(schema.soundCollectionItems).where(eq(schema.soundCollectionItems.collectionId, c.id));
      const [row] = await tx
        .insert(schema.soundCollectionItems)
        .values({
          organizationId: ws.organizationId,
          collectionId: c.id,
          provider,
          providerId: page,
          source: provider,
          title,
          creator,
          landingUrl: page,
          licence: provider === "pixabay" ? "pixabay" : "own",
          licenceUrl: provider === "pixabay" ? PIXABAY_LICENCE_URL : null,
          kind,
          durationSec,
          r2Path: input.key,
          mime: sniffed,
          sizeBytes: head.size,
          position: next,
          addedBy: ws.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new Error(`Bài này đã có trong «${c.name}»`);
      return { row, c };
    });
    await log("sound_collection.sound_imported", { collectionId: c.id, itemId: row.id, provider, title, pageUrl: page, sizeBytes: head.size });
    revalidatePath("/app/sounds");
    return { ok: true, message: `Đã thêm «${title}» vào «${c.name}»`, item: itemView(row) };
  } catch (e) {
    return fail(e);
  }
}
