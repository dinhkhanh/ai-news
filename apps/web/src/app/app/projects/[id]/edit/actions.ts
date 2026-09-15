"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectSceneRegenerateRequested } from "@/inngest/events";
import { busyStep } from "@/lib/project-state";
import { saveTimelineVersion } from "@/lib/review";
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
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "regenerate", lastError: null }).where(eq(schema.projects.id, input.projectId)));
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
