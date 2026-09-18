"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { VisualOption } from "@/components/editor/types";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectSceneRegenerateRequested } from "@/inngest/events";
import { recordUsageCost } from "@/lib/activity";
import { invokeMediaLambda } from "@/lib/media-lambda";
import { analyseAsset, faceGuardAvailable } from "@/lib/media/faces";
import { storedFrame, type FrameFaces } from "@/lib/media/framing";
import { downloadToR2 } from "@/lib/media/stock";
import { formatTimecode, manualSection, SHOT_SEC, webVideoPageUrl, youtubeId, type PendingCapture } from "@/lib/media/visual-plan";
import { storeWebVideo, webVideoEnabled } from "@/lib/media/webvideo";
import type { ChosenAsset } from "@/lib/media/broll";
import { busyStep, startProgress } from "@/lib/project-state";
import { deleteObject, headObject, presignGet, presignPut, r2Key } from "@/lib/r2";
import { queueRender } from "@/lib/render-request";
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

/** Export from the editor: render one saved version (same rules as the project page's render button). */
export async function renderTimeline(input: { projectId: string; timelineId: string; logoChannelId?: string | null; skipQa?: boolean }): Promise<EditorActionResult> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const r = await queueRender(ws, log, { projectId: input.projectId, timelineId: input.timelineId, logoChoice: input.logoChannelId || undefined, skipQa: input.skipQa === true });
    revalidatePath(`/app/projects/${input.projectId}`);
    revalidatePath(`/app/projects/${input.projectId}/edit`);
    return { ok: true, message: `Đang kết xuất v${r.version}${r.skipQa ? " (bỏ qua QA)" : ""}${r.logoName ? ` với logo ${r.logoName}` : ""} (${r.minutesToday}/${r.minutesLimit} phút hôm nay)…`, version: r.version, timelineId: r.timelineId };
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

/** Faces of a picture the editor just added, so the inspector can run the face guard on it (flag `face_guard`). */
async function guardFrame(asset: { assetId: string; key: string }, ctx: { userId: string; organizationId: string; projectId: string }) {
  if (!(await faceGuardAvailable()).enabled) return null;
  return (await analyseAsset(asset, ctx)).frame;
}

export type FrameResult = { ok: true; frame: FrameFaces; message: string } | { ok: false; message: string };

/**
 * Manual "auto-align" of one picture (uploads, stock and AI stills are not scanned by the build): detect its faces
 * once (kept in `assets.meta.frame`, so a second click is free) and hand them to the inspector, which runs the pure guard.
 */
export async function analyseVisual(input: { projectId: string; assetId: string }): Promise<FrameResult> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const asset = await withOrgContext(ws, (tx) => tx.query.assets.findFirst({ where: and(eq(schema.assets.projectId, input.projectId), eq(schema.assets.id, input.assetId)) }));
    if (!asset) throw new Error("Không tìm thấy hình này trong dự án");
    if (!((asset.mime ?? "").startsWith("image/") || asset.origin === "article")) throw new Error("Chỉ căn được ảnh tĩnh");
    const known = storedFrame(asset.meta);
    if (known) return { ok: true, frame: known, message: facesMessage(known.faces.length) };
    const guard = await faceGuardAvailable();
    if (!guard.enabled) throw new Error(`Nhận diện khuôn mặt chưa dùng được: ${guard.reason}`);
    const res = await analyseAsset({ assetId: asset.id, key: asset.r2Path }, { userId: ws.userId, organizationId: ws.organizationId, projectId: input.projectId });
    if (!res.frame) throw new Error(`Không phân tích được ảnh: ${res.error ?? "lỗi không rõ"}`);
    await log("asset.faces_analysed", { assetId: asset.id, faces: res.frame.faces.length, manual: true }, input.projectId);
    return { ok: true, frame: res.frame, message: facesMessage(res.frame.faces.length) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}
const facesMessage = (n: number) => (n ? `Đã nhận diện ${n} khuôn mặt` : "Không thấy khuôn mặt nào: giữ khung ở giữa");

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
    const option: VisualOption = { assetId: row.id, key: input.key, kind, durationSec, credit: null, thumbnailUrl: null, provider: "upload", sceneId: null, searchTerm: input.filename.slice(0, 80), rankScore: null, frame: kind === "image" ? await guardFrame({ assetId: row.id, key: input.key }, { ...ws, projectId: input.projectId }) : null, sourceUrl: null, section: null };
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
    const option: VisualOption = { assetId: row.id, key, kind, durationSec: null, credit: null, thumbnailUrl: kind === "image" ? url : null, provider: "url", sceneId: null, searchTerm: null, rankScore: null, frame: kind === "image" ? await guardFrame({ assetId: row.id, key }, { ...ws, projectId: input.projectId }) : null, sourceUrl: url, section: null };
    return { ok: true, option, url: await presignGet(key, 3600), message: kind === "video" ? "Đã lấy clip từ đường dẫn" : "Đã lấy ảnh từ đường dẫn" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

export type WebVideoAdded = VisualAdded | { ok: false; message: string; capture: PendingCapture };

/**
 * Fetch one section of a video page (YouTube, TikTok, Facebook reels / watch,
 * Vimeo, Dailymotion) pasted in the inspector: yt-dlp resolves the page
 * (metadata only), then only `[startSec, endSec)` is downloaded through the
 * web-video route (self-hosted API, else the media Lambda) and stored as a
 * `web_video` asset with the uploader's credit. A YouTube page the server
 * cannot fetch (datacenter IPs are bot-checked) comes back as a `capture` for
 * the in-browser recorder, aimed at the shot the user was filling.
 */
export async function importWebVideo(input: { projectId: string; url: string; startSec: number | null; endSec: number | null; sceneId: string; shot: number }): Promise<WebVideoAdded> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const url = webVideoPageUrl(input.url);
    if (!url) throw new Error("Dán link trang video (YouTube, TikTok, Facebook reels/watch, Vimeo, Dailymotion) hoặc link trực tiếp tới tệp");
    if (!(await webVideoEnabled())) throw new Error("Tải video web đang tắt (cờ web_video_downloader tại /admin/integrations)");
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId), columns: { id: true } }));
    if (!project) throw new Error("Project not found in this workspace");
    const first = manualSection({ startSec: input.startSec, endSec: input.endSec, durationSec: null });
    if (!first.ok) throw new Error(first.error);
    const meta = await invokeMediaLambda({ action: "web-video-search", input: { urls: [url], limit: 1 } });
    const c = meta.ok ? meta.videos?.[0] : undefined;
    if (!c) throw new Error(`Không đọc được trang video${meta.error ? `: ${meta.error}` : meta.warnings?.[0] ? `: ${meta.warnings[0]}` : ""}`);
    const section = manualSection({ startSec: input.startSec, endSec: input.endSec, durationSec: c.durationSec });
    if (!section.ok) throw new Error(section.error);
    const ctx = { ...ws, projectId: input.projectId };
    let asset: ChosenAsset;
    try {
      asset = await storeWebVideo(c, { buildId: `manual-${nanoid(6)}`, startSec: section.startSec, endSec: section.endSec, index: 0 }, ctx);
    } catch (e) {
      const videoId = youtubeId(url);
      const message = e instanceof Error ? e.message : "download failed";
      if (!videoId) throw new Error(`Không tải được đoạn video: ${message.slice(0, 200)}`);
      await log("asset.web_video_blocked", { url: url.slice(0, 300), startSec: section.startSec, endSec: section.endSec, error: message.slice(0, 300) }, input.projectId);
      const segments = Math.max(1, Math.ceil((section.endSec - section.startSec) / SHOT_SEC));
      return {
        ok: false,
        message: `YouTube chặn máy chủ (${message.slice(0, 120)}). Ghi đoạn ${formatTimecode(section.startSec)}–${formatTimecode(section.startSec + segments * SHOT_SEC)} ngay trong trình duyệt ở bảng “Ghi từ trình duyệt”.`,
        capture: { videoId, url, title: c.title, uploader: c.uploader, thumbnailUrl: c.thumbnailUrl, startSec: section.startSec, segments, scenes: [{ sceneId: input.sceneId, segments }], error: message.slice(0, 200), manual: { sceneId: input.sceneId, shot: input.shot } },
      };
    }
    await log("asset.imported_web_video", { assetId: asset.assetId, key: asset.key, url: url.slice(0, 300), site: c.site, startSec: section.startSec, endSec: section.endSec }, input.projectId);
    const option: VisualOption = { assetId: asset.assetId, key: asset.key, kind: "video", durationSec: asset.durationSec, credit: asset.credit, thumbnailUrl: asset.thumbnailUrl, provider: asset.provider, sceneId: null, searchTerm: null, rankScore: null, frame: null, sourceUrl: url, section: [section.startSec, section.endSec] };
    return { ok: true, option, url: await presignGet(asset.key, 3600), message: `Đã lấy ${formatTimecode(section.startSec)}–${formatTimecode(section.endSec)} từ ${c.site}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ browser captures */

const MEDIA_LAMBDA_USD_PER_SEC = 0.00006;

/**
 * A YouTube section recorded in the editor's own tab (`lib/media/tab-capture.ts`)
 * and uploaded through `createUploadUrl`: normalise it on the media Lambda
 * (CFR 30 H.264, exact length), then record it as a `web_video` asset with the
 * source video's credit. The raw recording is deleted.
 */
export async function registerWebCapture(input: {
  projectId: string;
  key: string;
  contentType: string;
  capture: { videoId: string; url: string; title: string; uploader: string | null; thumbnailUrl: string | null; startSec: number; durationSec: number };
}): Promise<VisualAdded> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const c = input.capture;
    if (input.contentType !== "video/webm" && input.contentType !== "video/mp4") throw new Error("Unsupported recording type");
    if (youtubeId(c.url) !== c.videoId) throw new Error("Đường dẫn YouTube không khớp");
    const durationSec = Math.round(Number(c.durationSec));
    if (!(durationSec >= 3 && durationSec <= 60) || !(c.startSec >= 0)) throw new Error("Đoạn ghi không hợp lệ");
    const prefix = r2Key.media(ws.organizationId, input.projectId, "uploads/");
    if (!input.key.startsWith(prefix)) throw new Error("Khoá tệp không hợp lệ");
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId), columns: { id: true } }));
    if (!project) throw new Error("Project not found in this workspace");
    const head = await headObject(input.key);
    if (!head.exists || head.size === 0) throw new Error("Tệp chưa được tải lên xong");
    const key = r2Key.media(ws.organizationId, input.projectId, `webvideo/cap-${c.videoId}-${nanoid(6)}.mp4`);
    const res = await invokeMediaLambda({ action: "transcode", input: { key: input.key }, output: { key }, trim: { startSec: 0, endSec: durationSec } });
    const costUsd = ((res.billedMs ?? 0) / 1000) * MEDIA_LAMBDA_USD_PER_SEC;
    await recordUsageCost({ provider: "media_lambda", resource: "transcode", units: (res.billedMs ?? 0) / 1000, unitType: "seconds", costUsd, userId: ws.userId, organizationId: ws.organizationId, projectId: input.projectId, meta: { videoId: c.videoId } });
    await deleteObject(input.key).catch(() => {});
    const probe = res.probe;
    if (!res.ok || !probe) throw new Error(`Chuyển mã thất bại: ${res.error ?? "không đọc được bản ghi"}`);
    const credit = `Video: ${c.uploader ? `${c.uploader.slice(0, 80)} / ` : ""}YouTube`;
    const clipSec = Math.round(probe.durationSec * 100) / 100;
    const [row] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.assets)
        .values({
          organizationId: ws.organizationId, projectId: input.projectId, origin: "web_video", provider: "yt-capture", providerId: `youtube:${c.videoId}@${c.startSec}-${c.startSec + durationSec}`, licence: "web video (editorial use, credited; recorded in the editor's browser)", sourceUrl: c.url, r2Path: key, mime: "video/mp4",
          width: probe.width, height: probe.height, durationSec: clipSec.toFixed(2), sizeBytes: probe.sizeBytes, thumbnailUrl: c.thumbnailUrl, attribution: credit,
          meta: { title: c.title.slice(0, 200), uploader: c.uploader, section: [c.startSec, c.startSec + durationSec], capturedBy: ws.userId, recordedAs: input.contentType },
        })
        .returning({ id: schema.assets.id }),
    );
    await log("asset.web_captured", { assetId: row.id, key, videoId: c.videoId, startSec: c.startSec, durationSec: clipSec, width: probe.width, height: probe.height, sizeBytes: probe.sizeBytes }, input.projectId);
    const option: VisualOption = { assetId: row.id, key, kind: "video", durationSec: clipSec, credit, thumbnailUrl: c.thumbnailUrl, provider: "yt-capture", sceneId: null, searchTerm: c.title.slice(0, 80), rankScore: null, frame: null, sourceUrl: c.url, section: [c.startSec, c.startSec + durationSec] };
    return { ok: true, option, url: await presignGet(key, 3600), message: "Đã ghi clip YouTube" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}
