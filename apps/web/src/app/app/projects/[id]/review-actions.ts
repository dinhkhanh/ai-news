"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { env } from "@/lib/env";
import { run, str, type ActionState } from "@/lib/admin";
import { notifySlack } from "@/lib/notify";
import { busyStep } from "@/lib/project-state";
import { canApprove, needsFaithfulnessOverride } from "@/lib/review";
import { assertWorkspaceWriter, type Workspace } from "@/lib/workspace";

/**
 * Approval flow (docs/PLAN.md §4.8 "Editor drafts, publisher approves.
 * Logged.") and review comments (§4.7). Every transition writes a
 * project_reviews row and an activity event.
 */

async function loadForReview(ws: Workspace, projectId: string) {
  const data = await withOrgContext(ws, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    if (!project) return null;
    const latest = await tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, projectId), orderBy: desc(schema.timelines.version) });
    return { project, latest };
  });
  if (!data) throw new Error("Project not found in this workspace");
  const busy = busyStep(data.project);
  if (busy) throw new Error(`Please wait: ${busy} is running`);
  if (!data.latest) throw new Error("Dựng timeline trước khi gửi duyệt");
  return { project: data.project, latest: data.latest };
}

const revalidate = (projectId: string) => {
  revalidatePath(`/app/projects/${projectId}`);
  revalidatePath(`/app/projects/${projectId}/edit`);
};

/** Editor sends the latest timeline version for a publisher's approval. */
export async function submitForReview(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const { project, latest } = await loadForReview(ws, projectId);
    if (project.state === "in_review") return "Dự án đã ở trạng thái chờ duyệt";
    if (!["composed", "approved", "rendered"].includes(project.state)) throw new Error(`Không thể gửi duyệt ở trạng thái ${project.state}`);
    const note = str(fd, "note") || null;
    await withOrgContext(ws, async (tx) => {
      await tx.insert(schema.projectReviews).values({ organizationId: ws.organizationId, projectId, timelineId: latest.id, timelineVersion: latest.version, action: "submitted", note, actorId: ws.userId });
      await tx.update(schema.projects).set({ state: "in_review", approvedTimelineId: null, approvedBy: null, approvedAt: null }).where(eq(schema.projects.id, projectId));
    });
    await log("review.submitted", { timelineId: latest.id, version: latest.version, note }, projectId);
    await notifySlack(`:eyes: Chờ duyệt — ${project.title ?? project.url} (timeline v${latest.version}) ${env().APP_URL}/app/projects/${projectId}`);
    revalidate(projectId);
    return `Đã gửi timeline v${latest.version} chờ publisher duyệt`;
  });
}

/** Submitter takes the project back to drafting. */
export async function withdrawReview(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const { project, latest } = await loadForReview(ws, projectId);
    if (project.state !== "in_review") throw new Error("Dự án không ở trạng thái chờ duyệt");
    await withOrgContext(ws, async (tx) => {
      await tx.insert(schema.projectReviews).values({ organizationId: ws.organizationId, projectId, timelineId: latest.id, timelineVersion: latest.version, action: "withdrawn", actorId: ws.userId });
      await tx.update(schema.projects).set({ state: "composed" }).where(eq(schema.projects.id, projectId));
    });
    await log("review.withdrawn", { timelineId: latest.id, version: latest.version }, projectId);
    revalidate(projectId);
    return "Đã rút khỏi hàng chờ duyệt";
  });
}

/**
 * Publisher approves the latest timeline version. Unsupported scenes in the
 * faithfulness check need an explicit, logged override (docs/PLAN.md §8).
 */
export async function approveTimeline(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    if (!canApprove(ws)) throw new Error("Chỉ publisher hoặc admin workspace mới được duyệt");
    const projectId = str(fd, "projectId");
    const { project, latest } = await loadForReview(ws, projectId);
    const timelineId = str(fd, "timelineId");
    if (timelineId && timelineId !== latest.id) throw new Error(`Chỉ duyệt được phiên bản mới nhất (v${latest.version}). Tải lại trang.`);
    if (!["composed", "in_review", "rendered"].includes(project.state)) throw new Error(`Không thể duyệt ở trạng thái ${project.state}`);
    const script = latest.scriptId ? await withOrgContext(ws, (tx) => tx.query.scripts.findFirst({ where: eq(schema.scripts.id, latest.scriptId!) })) : null;
    const needsOverride = needsFaithfulnessOverride(script);
    const override = fd.get("override") === "on";
    if (needsOverride && !override) throw new Error("Kịch bản có cảnh chưa được kiểm chứng. Tick “Duyệt dù có cảnh không căn cứ” để duyệt (được ghi log).");
    const note = str(fd, "note") || null;
    const doneRender = await withOrgContext(ws, (tx) => tx.query.renders.findFirst({ where: and(eq(schema.renders.timelineId, latest.id), eq(schema.renders.status, "done")), orderBy: desc(schema.renders.createdAt) }));
    await withOrgContext(ws, async (tx) => {
      await tx.insert(schema.projectReviews).values({ organizationId: ws.organizationId, projectId, timelineId: latest.id, timelineVersion: latest.version, action: "approved", note, faithfulnessOverride: needsOverride && override, actorId: ws.userId });
      await tx
        .update(schema.projects)
        .set({ state: doneRender ? "rendered" : "approved", approvedTimelineId: latest.id, approvedBy: ws.userId, approvedAt: new Date() })
        .where(eq(schema.projects.id, projectId));
    });
    await log("review.approved", { timelineId: latest.id, version: latest.version, note, faithfulnessOverride: needsOverride && override, sensitiveTopic: project.sensitiveTopic, renderId: doneRender?.id ?? null }, projectId);
    if (needsOverride && override) await log("review.faithfulness_override", { timelineId: latest.id, version: latest.version, scriptId: script?.id ?? null }, projectId);
    await notifySlack(`:white_check_mark: Đã duyệt — ${project.title ?? project.url} (timeline v${latest.version}${doneRender ? ", đã có bản kết xuất" : ", chờ kết xuất"}) ${env().APP_URL}/app/projects/${projectId}`);
    revalidate(projectId);
    return doneRender ? `Đã duyệt v${latest.version}; bản kết xuất sẵn có được dùng làm bản chính` : `Đã duyệt v${latest.version}. Kết xuất để có bản chính.`;
  });
}

/** Publisher sends the project back with a note. */
export async function requestChanges(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    if (!canApprove(ws)) throw new Error("Chỉ publisher hoặc admin workspace mới được trả lại");
    const projectId = str(fd, "projectId");
    const { project, latest } = await loadForReview(ws, projectId);
    const note = str(fd, "note");
    if (note.length < 3) throw new Error("Ghi rõ cần sửa gì");
    await withOrgContext(ws, async (tx) => {
      await tx.insert(schema.projectReviews).values({ organizationId: ws.organizationId, projectId, timelineId: latest.id, timelineVersion: latest.version, action: "changes_requested", note, actorId: ws.userId });
      await tx.insert(schema.comments).values({ organizationId: ws.organizationId, projectId, timelineId: latest.id, body: `[Yêu cầu sửa] ${note}`, authorId: ws.userId });
      await tx.update(schema.projects).set({ state: "composed", approvedTimelineId: null, approvedBy: null, approvedAt: null }).where(eq(schema.projects.id, projectId));
    });
    await log("review.changes_requested", { timelineId: latest.id, version: latest.version, note }, projectId);
    await notifySlack(`:leftwards_arrow_with_hook: Yêu cầu sửa — ${project.title ?? project.url}: ${note.slice(0, 200)} ${env().APP_URL}/app/projects/${projectId}`);
    revalidate(projectId);
    return "Đã trả lại để sửa";
  });
}

/** Comment on the project, optionally anchored to a scene and a timestamp. */
export async function addComment(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const body = String(fd.get("body") ?? "").trim();
    if (body.length < 1) throw new Error("Bình luận trống");
    if (body.length > 4000) throw new Error("Bình luận quá dài");
    const timelineId = str(fd, "timelineId") || null;
    const sceneId = str(fd, "sceneId") || null;
    const atRaw = str(fd, "atMs");
    const atMs = atRaw ? Math.max(0, Math.round(Number(atRaw))) : null;
    const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { id: true } }));
    if (!project) throw new Error("Project not found in this workspace");
    const [row] = await withOrgContext(ws, (tx) =>
      tx.insert(schema.comments).values({ organizationId: ws.organizationId, projectId, timelineId, sceneId, atMs: Number.isFinite(atMs) ? atMs : null, body, authorId: ws.userId }).returning({ id: schema.comments.id }),
    );
    await log("comment.created", { commentId: row.id, sceneId, atMs, length: body.length }, projectId);
    revalidate(projectId);
    return "Đã thêm bình luận";
  });
}

export async function toggleCommentResolved(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const commentId = str(fd, "commentId");
    const c = await withOrgContext(ws, (tx) => tx.query.comments.findFirst({ where: eq(schema.comments.id, commentId) }));
    if (!c) throw new Error("Comment not found");
    const resolved = !c.resolvedAt;
    await withOrgContext(ws, (tx) => tx.update(schema.comments).set({ resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? ws.userId : null }).where(eq(schema.comments.id, commentId)));
    await log(resolved ? "comment.resolved" : "comment.reopened", { commentId }, c.projectId);
    revalidate(c.projectId);
    return resolved ? "Đã đánh dấu xong" : "Đã mở lại";
  });
}
