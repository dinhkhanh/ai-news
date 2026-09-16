import "server-only";
import { and, desc, eq, gte, lt, or, isNull } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext, withServiceContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { env } from "@/lib/env";
import { notifySlack } from "@/lib/notify";
import { headObject, presignGet } from "@/lib/r2";
import { clientFor } from "./index";
import { channelAccessToken } from "./oauth";
import type { Platform } from "./platforms";
import { PlatformError, type CheckResult, type PublicationMetadata, type PublishJob } from "./types";

/**
 * Publication lifecycle shared by the Inngest publish function, the
 * processing-poll cron and the admin retry path (docs/PLAN.md §4.10).
 *
 *   scheduled → publishing → processing → published
 *                         ↘ failed         (cancelled only from scheduled)
 */

export type Ctx = { userId: string; organizationId: string };

export async function loadPublication(ctx: Ctx, publicationId: string) {
  return withOrgContext(ctx, async (tx) => {
    const pub = await tx.query.publications.findFirst({ where: eq(schema.publications.id, publicationId) });
    if (!pub) return null;
    const [channel, render, project] = await Promise.all([
      tx.query.channels.findFirst({ where: eq(schema.channels.id, pub.channelId) }),
      tx.query.renders.findFirst({ where: eq(schema.renders.id, pub.renderId) }),
      pub.projectId ? tx.query.projects.findFirst({ where: eq(schema.projects.id, pub.projectId) }) : Promise.resolve(null),
    ]);
    return { pub: pub as typeof pub & { metadata: PublicationMetadata }, channel, render, project };
  });
}

/** Everything the platform client needs: fresh token + presigned video URLs (3 h, enough for Meta to pull the file). */
export async function buildJob(ctx: Ctx, publicationId: string): Promise<PublishJob> {
  const data = await loadPublication(ctx, publicationId);
  if (!data) throw new PlatformError("Publication not found", true);
  const { pub, channel, render, project } = data;
  if (!channel) throw new PlatformError("Channel no longer exists", true);
  if (!channel.enabled) throw new PlatformError("Channel is paused by an admin", true);
  if (!render?.outputPath || render.status !== "done") throw new PlatformError("Render is not finished", true);
  const head = await headObject(render.outputPath);
  if (!head.exists) throw new PlatformError("Rendered file is no longer in storage", true);
  const token = await channelAccessToken(channel);
  const [presignedUrl, coverUrl] = await Promise.all([presignGet(render.outputPath, 3 * 3600), render.coverPath ? presignGet(render.coverPath, 3 * 3600).catch(() => null) : Promise.resolve(null)]);
  return {
    publication: pub,
    channel,
    token,
    video: { key: render.outputPath, sizeBytes: head.size, durationSec: Number(render.durationSec ?? 0), presignedUrl, coverUrl },
    language: project?.language ?? "vi",
  };
}

export async function recordQuota(platform: Platform, units: number | undefined, ctx: Ctx, extra: { projectId?: string | null; publicationId: string; op: string }) {
  if (platform !== "youtube" || !units) return;
  await recordUsageCost({ provider: "youtube_api", resource: extra.op, units, unitType: "quota_units", costUsd: 0, userId: ctx.userId, organizationId: ctx.organizationId, projectId: extra.projectId ?? null, meta: { publicationId: extra.publicationId } });
}

/** Persist a platform check result; returns the new status. */
export async function applyCheck(ctx: Ctx, pub: { id: string; projectId: string | null; platform: Platform; metadata: PublicationMetadata; channelId: string }, result: CheckResult, opts: { title?: string | null } = {}) {
  const now = new Date();
  if (result.state === "published") {
    await withOrgContext(ctx, async (tx) => {
      await tx
        .update(schema.publications)
        .set({
          status: "published",
          platformPostId: result.postId ?? undefined,
          platformUrl: result.url ?? undefined,
          publishedAt: now,
          lastCheckedAt: now,
          error: null,
          metadata: { ...pub.metadata, handles: { ...(pub.metadata.handles ?? {}), ...(result.handles ?? {}) }, lastStatus: result.raw ?? null } as Record<string, unknown>,
        })
        .where(eq(schema.publications.id, pub.id));
      if (pub.projectId) await tx.update(schema.projects).set({ state: "published", busyStep: null }).where(eq(schema.projects.id, pub.projectId));
    });
    await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId: pub.projectId, type: "publication.published", payload: { publicationId: pub.id, platform: pub.platform, postId: result.postId ?? null, url: result.url ?? null } });
    await notifySlack(`:rocket: Published on ${pub.platform} — ${opts.title ?? pub.id} ${result.url ?? ""} ${env().APP_URL}/app/projects/${pub.projectId ?? ""}`);
    return "published" as const;
  }
  if (result.state === "failed") {
    await withOrgContext(ctx, (tx) =>
      tx.update(schema.publications).set({ status: "failed", error: (result.error ?? "failed").slice(0, 2000), lastCheckedAt: now, metadata: { ...pub.metadata, lastStatus: result.raw ?? null } as Record<string, unknown> }).where(eq(schema.publications.id, pub.id)),
    );
    await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, projectId: pub.projectId, type: "publication.failed", payload: { publicationId: pub.id, platform: pub.platform, error: (result.error ?? "").slice(0, 500) } });
    await notifySlack(`:x: Publish failed on ${pub.platform} — ${opts.title ?? pub.id}: ${(result.error ?? "").slice(0, 300)}`);
    return "failed" as const;
  }
  await withOrgContext(ctx, (tx) =>
    tx.update(schema.publications).set({ status: "processing", lastCheckedAt: now, metadata: { ...pub.metadata, handles: { ...(pub.metadata.handles ?? {}), ...(result.handles ?? {}) }, lastStatus: result.raw ?? null } as Record<string, unknown> }).where(eq(schema.publications.id, pub.id)),
  );
  return "processing" as const;
}

/** One status check for a processing publication (used by the publish function and the poll cron). */
export async function checkPublication(ctx: Ctx, publicationId: string) {
  const data = await loadPublication(ctx, publicationId);
  if (!data) return "missing" as const;
  const { pub, channel, project } = data;
  if (pub.status !== "processing") return pub.status;
  if (!channel) return applyCheck(ctx, pub, { state: "failed", error: "Channel no longer exists" });
  try {
    const token = await channelAccessToken(channel);
    const result = await clientFor(pub.platform).check({ publication: pub, channel, token });
    await recordQuota(pub.platform, result.quotaUnits, ctx, { projectId: pub.projectId, publicationId: pub.id, op: "videos.list" });
    return applyCheck(ctx, pub, result, { title: project?.title });
  } catch (err) {
    if (err instanceof PlatformError && err.permanent) return applyCheck(ctx, pub, { state: "failed", error: err.message }, { title: project?.title });
    // Transient: leave it processing; the cron tries again.
    await withOrgContext(ctx, (tx) => tx.update(schema.publications).set({ lastCheckedAt: new Date(), error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) }).where(eq(schema.publications.id, pub.id)));
    return "processing" as const;
  }
}

/** Processing publications whose last check is older than `staleMs` (cross-workspace, for the cron). */
export async function staleProcessing(staleMs: number, limit = 50) {
  const before = new Date(Date.now() - staleMs);
  return withServiceContext((tx) =>
    tx
      .select({ id: schema.publications.id, organizationId: schema.publications.organizationId, createdBy: schema.publications.createdBy })
      .from(schema.publications)
      .where(and(eq(schema.publications.status, "processing"), or(isNull(schema.publications.lastCheckedAt), lt(schema.publications.lastCheckedAt, before))))
      .orderBy(schema.publications.lastCheckedAt)
      .limit(limit),
  );
}

/** Daily analytics pull (docs/PLAN.md §4.10): per channel, batch the published posts of the last `days` days. */
export async function pullChannelAnalytics(channelId: string, days = 90) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const channel = await withServiceContext((tx) => tx.query.channels.findFirst({ where: eq(schema.channels.id, channelId) }));
  if (!channel) return { channelId, pulled: 0, error: "channel missing" };
  const pubs = await withServiceContext((tx) =>
    tx
      .select({ id: schema.publications.id, postId: schema.publications.platformPostId, projectId: schema.publications.projectId, createdBy: schema.publications.createdBy })
      .from(schema.publications)
      .where(and(eq(schema.publications.channelId, channelId), eq(schema.publications.status, "published"), gte(schema.publications.publishedAt, since)))
      .orderBy(desc(schema.publications.publishedAt)),
  );
  const withIds = pubs.filter((p): p is typeof p & { postId: string } => Boolean(p.postId));
  if (withIds.length === 0) return { channelId, pulled: 0 };
  try {
    const token = await channelAccessToken(channel);
    const { byPost, quotaUnits } = await clientFor(channel.platform).analytics(channel, token, withIds.map((p) => p.postId));
    const now = new Date();
    let pulled = 0;
    await withServiceContext(async (tx) => {
      for (const p of withIds) {
        const a = byPost[p.postId];
        if (!a) continue;
        await tx.update(schema.publications).set({ analyticsJson: a as unknown as Record<string, unknown>, analyticsAt: now }).where(eq(schema.publications.id, p.id));
        pulled++;
      }
      await tx.update(schema.channels).set({ healthy: true, lastError: null, lastCheckedAt: now }).where(eq(schema.channels.id, channelId));
    });
    if (channel.platform === "youtube" && quotaUnits) {
      await recordUsageCost({ provider: "youtube_api", resource: "videos.list:statistics", units: quotaUnits, unitType: "quota_units", costUsd: 0, organizationId: channel.organizationId, meta: { channelId, posts: withIds.length } });
    }
    return { channelId, pulled };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withServiceContext((tx) => tx.update(schema.channels).set({ lastError: message.slice(0, 1000), lastCheckedAt: new Date() }).where(eq(schema.channels.id, channelId)));
    return { channelId, pulled: 0, error: message };
  }
}
