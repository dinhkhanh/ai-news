"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { VisualOption } from "@/components/editor/types";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectSceneRegenerateRequested } from "@/inngest/events";
import { downloadToR2 } from "@/lib/media/stock";
import { busyStep, startProgress } from "@/lib/project-state";
import { deleteObject, headObject, presignGet, presignPut, r2Key } from "@/lib/r2";
import { saveTimelineVersion } from "@/lib/review";
import { isPrivateHost } from "@/lib/url";
import { assertWorkspaceWriter } from "@/lib/workspace";

export type EditorActionResult = { ok: boolean; message: string; version?: number; timelineId?: string };

const fail = (e: unknown): EditorActionResult => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong" });

/** Save the editor document as a new timeline version (docs/PLAN.md §4.7 "Each save = new version"). */
export async function saveTimeline(input: { projectId: string; baseVersion: number; doc: unknown; note?: string }): Promise<EditorActionResult> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId) }));
    if (!project) throw new Error("Project not found in this workspace");
    const busy = busyStep(project);
    if (busy) throw new Error(`Đợi bước ${busy} chạy xong`);
    const saved = await saveTimelineVersion({ ws, projectId: input.projectId, doc: input.doc, baseVersion: Number(input.baseVersion), kind: "edited", note: input.note?.slice(0, 500) ?? null });
    await log("timeline.saved", { timelineId: saved.id, version: saved.version, changes: saved.changes, approvalCleared: saved.approvalCleared }, input.projectId);
    revalidatePath(`/app/projects/${input.projectId}`);
    revalidatePath(`/app/projects/${input.projectId}/edit`);
    return { ok: true, message: `Đã lưu timeline v${saved.version}${saved.approvalCleared ? " (bản duyệt cũ bị huỷ, cần duyệt lại)" : ""}`, version: saved.version, timelineId: saved.id };
  } catch (e) {
    return fail(e);
  }
}

/** Redo one scene's B-roll or voice-over, or pick new music, as a background step that stores a new version. */
export async function regenerateScene(input: { projectId: string; timelineId: string; what: "broll" | "voice" | "music"; sceneId?: string; voiceover?: string; brollTerms?: string[] }): Promise<EditorActionResult> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId) }));
    if (!project) throw new Error("Project not found in this workspace");
    const busy = busyStep(project);
    if (busy) throw new Error(`Đợi bước ${busy} chạy xong`);
    const latest = await withOrgContext(ws, (tx) => tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, input.projectId), orderBy: desc(schema.timelines.version) }));
    if (!latest || latest.id !== input.timelineId) throw new Error("Chỉ tạo lại được trên phiên bản mới nhất. Tải lại trang.");
    if (input.what !== "music" && !input.sceneId) throw new Error("Thiếu cảnh");
    const timeline = await withOrgContext(ws, (tx) => tx.query.timelines.findFirst({ where: and(eq(schema.timelines.projectId, input.projectId), eq(schema.timelines.id, input.timelineId)) }));
    if (!timeline) throw new Error("Timeline not found");
    const voiceover = input.voiceover?.trim().slice(0, 2000) || undefined;
    const brollTerms = input.brollTerms?.map((t) => t.trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "regenerate", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, input.projectId)));
    await inngest.send(
      projectSceneRegenerateRequested.create({ projectId: input.projectId, organizationId: ws.organizationId, requestedBy: ws.userId, timelineId: input.timelineId, what: input.what, sceneId: input.sceneId, voiceover, brollTerms: brollTerms?.length ? brollTerms : undefined }),
    );
    await log("scene.regenerate_requested", { timelineId: input.timelineId, version: timeline.version, what: input.what, sceneId: input.sceneId ?? null, textEdited: Boolean(voiceover), terms: brollTerms ?? null }, input.projectId);
    revalidatePath(`/app/projects/${input.projectId}/edit`);
    const label = input.what === "voice" ? "Đang đọc lại lời" : input.what === "broll" ? "Đang tìm B-roll mới" : "Đang chọn nhạc mới";
    return { ok: true, message: `${label}… kết quả sẽ thành phiên bản v${timeline.version + 1}` };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ uploads */

const UPLOAD_TYPES: Record<string, "image" | "video"> = { "image/jpeg": "image", "image/png": "image", "image/webp": "image", "video/mp4": "video", "video/quicktime": "video", "video/webm": "video" };
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
const extOf = (name: string, mime: string) => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  return mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "video/quicktime" ? "mov" : mime === "video/webm" ? "webm" : "mp4";
};

export type UploadTicket = { ok: true; key: string; url: string; kind: "image" | "video" } | { ok: false; message: string };
export type VisualAdded = { ok: true; option: VisualOption; url: string; message: string } | { ok: false; message: string };

/** Presigned PUT for a browser upload straight to R2 (bucket CORS must allow the app origin: infra/r2/cors.json). */
export async function createUploadUrl(input: { projectId: string; filename: string; contentType: string; sizeBytes: number }): Promise<UploadTicket> {
  try {
    const { ws } = await assertWorkspaceWriter();
    const kind = UPLOAD_TYPES[input.contentType];
    if (!kind) throw new Error("Chỉ nhận JPG, PNG, WebP, MP4, MOV hoặc WebM");
    if (!(input.sizeBytes > 0) || input.sizeBytes > UPLOAD_MAX_BYTES) throw new Error("Tệp tối đa 200 MB");
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId), columns: { id: true } }));
    if (!project) throw new Error("Project not found in this workspace");
    const key = r2Key.media(ws.organizationId, input.projectId, `uploads/${nanoid(10)}.${extOf(input.filename, input.contentType)}`);
    return { ok: true, key, url: await presignPut(key, input.contentType, 900), kind };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

/** After the browser PUT: verify the object, record it as an `upload` asset and hand back a swap option. */
export async function registerUpload(input: { projectId: string; key: string; filename: string; contentType: string; width?: number | null; height?: number | null; durationSec?: number | null }): Promise<VisualAdded> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const kind = UPLOAD_TYPES[input.contentType];
    if (!kind) throw new Error("Unsupported file type");
    const prefix = r2Key.media(ws.organizationId, input.projectId, "uploads/");
    if (!input.key.startsWith(prefix)) throw new Error("Khoá tệp không hợp lệ");
    const head = await headObject(input.key);
    if (!head.exists || head.size === 0) throw new Error("Tệp chưa được tải lên xong");
    if (head.size > UPLOAD_MAX_BYTES) {
      await deleteObject(input.key).catch(() => {});
      throw new Error("Tệp tối đa 200 MB");
    }
    const durationSec = kind === "video" && input.durationSec && input.durationSec > 0 ? Math.round(input.durationSec * 100) / 100 : null;
    const [row] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.assets)
        .values({ organizationId: ws.organizationId, projectId: input.projectId, origin: "upload", provider: "upload", r2Path: input.key, mime: input.contentType, width: input.width ?? null, height: input.height ?? null, durationSec: durationSec?.toFixed(2) ?? null, sizeBytes: head.size, licence: "uploaded by editor", attribution: null, meta: { filename: input.filename.slice(0, 200), uploadedBy: ws.userId } })
        .returning({ id: schema.assets.id }),
    );
    await log("asset.uploaded", { assetId: row.id, key: input.key, kind, sizeBytes: head.size, durationSec }, input.projectId);
    const option: VisualOption = { assetId: row.id, key: input.key, kind, durationSec, credit: null, thumbnailUrl: null, provider: "upload", sceneId: null, searchTerm: input.filename.slice(0, 80), rankScore: null };
    return { ok: true, option, url: await presignGet(input.key, 3600), message: kind === "video" ? "Đã tải clip lên" : "Đã tải ảnh lên" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

/** Fetch a direct image/video URL into R2 as an `upload` asset (server-side, 80 MB cap) and return a swap option. */
export async function importVisualFromUrl(input: { projectId: string; url: string }): Promise<VisualAdded> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const url = input.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("Dán một đường dẫn http(s) trực tiếp tới ảnh hoặc video");
    if (isPrivateHost(url)) throw new Error("Không tải từ địa chỉ nội bộ");
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId), columns: { id: true } }));
    if (!project) throw new Error("Project not found in this workspace");
    const guess = /\.(jpe?g|png|webp|mp4|mov|webm)(?:$|\?)/i.exec(url)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "bin";
    const key = r2Key.media(ws.organizationId, input.projectId, `uploads/${nanoid(10)}.${guess}`);
    const dl = await downloadToR2(url, key, guess === "bin" ? "application/octet-stream" : guess === "mp4" || guess === "mov" || guess === "webm" ? "video/mp4" : "image/jpeg");
    const kind = dl.contentType.startsWith("image/") ? "image" : dl.contentType.startsWith("video/") ? "video" : null;
    if (!kind) {
      await deleteObject(key).catch(() => {});
      throw new Error(`Đường dẫn không trả về ảnh/video (${dl.contentType}). Cần link trực tiếp tới tệp, không phải trang web.`);
    }
    const [row] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.assets)
        .values({ organizationId: ws.organizationId, projectId: input.projectId, origin: "upload", provider: "url", sourceUrl: url, r2Path: key, hash: dl.hash, mime: dl.contentType, sizeBytes: dl.sizeBytes, licence: "linked by editor", attribution: null, thumbnailUrl: kind === "image" ? url : null, meta: { importedBy: ws.userId } })
        .returning({ id: schema.assets.id }),
    );
    await log("asset.imported_url", { assetId: row.id, key, kind, sizeBytes: dl.sizeBytes, url: url.slice(0, 300) }, input.projectId);
    const option: VisualOption = { assetId: row.id, key, kind, durationSec: null, credit: null, thumbnailUrl: kind === "image" ? url : null, provider: "url", sceneId: null, searchTerm: null, rankScore: null };
    return { ok: true, option, url: await presignGet(key, 3600), message: kind === "video" ? "Đã lấy clip từ đường dẫn" : "Đã lấy ảnh từ đường dẫn" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}
