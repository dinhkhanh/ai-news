"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { publicationCancelled, publicationRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { flagsEnabled } from "@/lib/flags";
import { idempotencyKey, isPlatform, normaliseHashtags, parseVietnamLocal, PLATFORM_SPEC, validateMetadata, type PublishMetadata } from "@/lib/publish/platforms";
import { assertQuota } from "@/lib/quota";
import { canApprove } from "@/lib/review";
import { assertWorkspaceWriter, type Workspace } from "@/lib/workspace";

/**
 * Publishing (docs/PLAN.md §4.10): publisher-level role + channel grant,
 * platform feature flag, daily publish quota, approved render only, metadata
 * within platform limits, optional schedule (flag). One row per attempt key.
 */

const revalidate = (projectId: string) => {
  revalidatePath(`/app/projects/${projectId}`);
  revalidatePath("/app/publications");
};

async function assertPublisher(ws: Workspace, channelId: string) {
  if (!canApprove(ws)) throw new Error("Chỉ publisher hoặc admin workspace mới được đăng");
  const channel = await withOrgContext(ws, (tx) => tx.query.channels.findFirst({ where: eq(schema.channels.id, channelId) }));
  if (!channel) throw new Error("Kênh không thuộc workspace này");
  if (!channel.enabled || !channel.vaultRef) throw new Error("Kênh đang tạm dừng hoặc chưa kết nối; kiểm tra ở /app/channels");
  if (!ws.isAdmin) {
    const grant = await withOrgContext(ws, (tx) => tx.query.channelGrants.findFirst({ where: and(eq(schema.channelGrants.channelId, channelId), eq(schema.channelGrants.userId, ws.userId)) }));
    if (!grant) throw new Error("Bạn chưa được cấp quyền đăng lên kênh này");
  }
  return channel;
}

export async function createPublication(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const channelId = str(fd, "channelId");
    const renderId = str(fd, "renderId");
    const channel = await assertPublisher(ws, channelId);
    const platform = channel.platform;
    if (!isPlatform(platform)) throw new Error("Nền tảng không hỗ trợ");
    const spec = PLATFORM_SPEC[platform];
    const flags = await flagsEnabled([spec.flag, "scheduling"]);
    if (!flags[spec.flag]) throw new Error(`${spec.label} đang tắt trong /admin/integrations`);

    const data = await withOrgContext(ws, async (tx) => {
      const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
      const render = await tx.query.renders.findFirst({ where: and(eq(schema.renders.id, renderId), eq(schema.renders.projectId, projectId)) });
      const attempts = await tx.query.publications.findMany({ where: and(eq(schema.publications.renderId, renderId), eq(schema.publications.channelId, channelId)), orderBy: desc(schema.publications.attempts) });
      return { project, render, attempts };
    });
    if (!data.project) throw new Error("Project not found in this workspace");
    if (!data.render || data.render.status !== "done" || !data.render.outputPath) throw new Error("Chỉ đăng được bản kết xuất đã hoàn tất");
    if (!data.project.approvedTimelineId || data.render.timelineId !== data.project.approvedTimelineId) throw new Error("Chỉ đăng được bản kết xuất của phiên bản đã duyệt");
    if (!["rendered", "published"].includes(data.project.state)) throw new Error(`Không thể đăng ở trạng thái ${data.project.state}`);
    const active = data.attempts.find((a) => ["scheduled", "publishing", "processing", "published"].includes(a.status));
    if (active) throw new Error(active.status === "published" ? `Bản này đã đăng lên ${channel.name}` : `Đã có lượt đăng ${active.status} lên ${channel.name}`);

    const metadata: PublishMetadata = {
      title: str(fd, "title"),
      description: String(fd.get("description") ?? "").replace(/\r\n?/g, "\n").trim(),
      hashtags: normaliseHashtags(str(fd, "hashtags").split(/[\s,]+/), platform),
    };
    const privacy = str(fd, "privacy") || spec.privacy[0];
    const aiDisclosure = fd.get("aiDisclosure") === "on";
    const errors = validateMetadata(platform, metadata, privacy, data.render.durationSec ? Number(data.render.durationSec) : null);
    if (errors.length) throw new Error(errors.join("; "));
    const scheduledRaw = str(fd, "scheduledAt");
    let scheduledAt: Date | null = null;
    if (scheduledRaw) {
      if (!flags.scheduling) throw new Error("Lên lịch đăng đang tắt trong /admin/integrations");
      scheduledAt = parseVietnamLocal(scheduledRaw);
      if (!scheduledAt) throw new Error("Thời gian lên lịch không hợp lệ");
      if (scheduledAt.getTime() < Date.now() - 60_000) throw new Error("Thời gian lên lịch đã qua");
      if (scheduledAt.getTime() > Date.now() + 30 * 24 * 3600 * 1000) throw new Error("Chỉ lên lịch tối đa 30 ngày");
    }
    const quota = await assertQuota(ws.userId, "publishes");
    const attempt = (data.attempts[0]?.attempts ?? 0) + 1;
    const [row] = await withOrgContext(ws, async (tx) => {
      if (aiDisclosure !== data.project!.aiDisclosure) await tx.update(schema.projects).set({ aiDisclosure }).where(eq(schema.projects.id, projectId));
      return tx
        .insert(schema.publications)
        .values({
          organizationId: ws.organizationId,
          projectId,
          channelId,
          renderId,
          platform,
          idempotencyKey: idempotencyKey(renderId, channelId, attempt),
          attempts: attempt,
          status: "scheduled",
          metadata: metadata as unknown as Record<string, unknown>,
          privacy,
          aiDisclosure,
          scheduledAt: scheduledAt ?? new Date(),
          createdBy: ws.userId,
        })
        .returning({ id: schema.publications.id });
    });
    await log("quota.publishes", { publicationId: row.id }, projectId);
    await inngest.send(publicationRequested.create({ publicationId: row.id, organizationId: ws.organizationId, requestedBy: ws.userId, channelId }));
    await log(scheduledAt ? "publication.scheduled" : "publication.requested", { publicationId: row.id, platform, channelId, renderId, scheduledAt: scheduledAt?.toISOString() ?? null, privacy, aiDisclosure, quotaUsed: quota.used + 1, quotaLimit: quota.limit }, projectId);
    revalidate(projectId);
    return scheduledAt ? `Đã lên lịch đăng lên ${channel.name} (${quota.used + 1}/${quota.limit} hôm nay)` : `Đang đăng lên ${channel.name}… (${quota.used + 1}/${quota.limit} hôm nay)`;
  });
}

export async function cancelPublication(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const publicationId = str(fd, "publicationId");
    const pub = await withOrgContext(ws, (tx) => tx.query.publications.findFirst({ where: eq(schema.publications.id, publicationId) }));
    if (!pub) throw new Error("Publication not found");
    if (!canApprove(ws) && pub.createdBy !== ws.userId) throw new Error("Chỉ người tạo hoặc publisher mới được huỷ");
    if (pub.status !== "scheduled") throw new Error(`Chỉ huỷ được lượt đăng đang chờ lịch (hiện: ${pub.status})`);
    await withOrgContext(ws, (tx) => tx.update(schema.publications).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(schema.publications.id, publicationId)));
    await inngest.send(publicationCancelled.create({ publicationId }));
    await log("publication.cancelled", { publicationId, platform: pub.platform }, pub.projectId ?? undefined);
    if (pub.projectId) revalidate(pub.projectId);
    return "Đã huỷ lượt đăng";
  });
}

/** Retry a failed attempt with a fresh idempotency key (docs/PLAN.md §4.10). */
export async function retryPublication(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const publicationId = str(fd, "publicationId");
    const pub = await withOrgContext(ws, (tx) => tx.query.publications.findFirst({ where: eq(schema.publications.id, publicationId) }));
    if (!pub) throw new Error("Publication not found");
    if (pub.status !== "failed" && pub.status !== "cancelled") throw new Error(`Chỉ thử lại lượt đăng lỗi/đã huỷ (hiện: ${pub.status})`);
    await assertPublisher(ws, pub.channelId);
    const quota = await assertQuota(ws.userId, "publishes");
    const attempt = pub.attempts + 1;
    const meta = { ...(pub.metadata as Record<string, unknown>) };
    delete meta.handles;
    delete meta.sent;
    delete meta.lastStatus;
    await withOrgContext(ws, (tx) =>
      tx
        .update(schema.publications)
        .set({ status: "scheduled", scheduledAt: new Date(), attempts: attempt, idempotencyKey: idempotencyKey(pub.renderId, pub.channelId, attempt), error: null, platformPostId: null, platformUrl: null, cancelledAt: null, metadata: meta })
        .where(eq(schema.publications.id, publicationId)),
    );
    await log("quota.publishes", { publicationId }, pub.projectId ?? undefined);
    await inngest.send(publicationRequested.create({ publicationId, organizationId: ws.organizationId, requestedBy: ws.userId, channelId: pub.channelId }));
    await log("publication.retried", { publicationId, platform: pub.platform, attempt, quotaUsed: quota.used + 1, quotaLimit: quota.limit }, pub.projectId ?? undefined);
    if (pub.projectId) revalidate(pub.projectId);
    return `Đang thử lại (lần ${attempt})…`;
  });
}
