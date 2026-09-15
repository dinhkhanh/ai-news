import "server-only";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { QUOTA_RESOURCES } from "@/lib/integrations";

type Resource = (typeof QUOTA_RESOURCES)[number]["key"];

/** Start of the current day in the newsroom's timezone (Asia/Ho_Chi_Minh, UTC+7). */
export function dayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + 7 * 3600 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 7 * 3600 * 1000);
}

export async function dailyLimit(userId: string, resource: Resource) {
  const rows = await db
    .select()
    .from(schema.quotas)
    .where(and(eq(schema.quotas.scope, "user"), eq(schema.quotas.resource, resource), inArray(schema.quotas.scopeId, [userId, "*"])));
  const specific = rows.find((r) => r.scopeId === userId);
  const fallback = rows.find((r) => r.scopeId === "*");
  return specific?.dailyLimit ?? fallback?.dailyLimit ?? QUOTA_RESOURCES.find((q) => q.key === resource)?.defaultUser ?? 0;
}

export async function usedToday(userId: string, resource: Resource) {
  const since = dayStart();
  if (resource === "scripts") {
    return withServiceContext(async (tx) => {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(schema.scripts)
        .where(and(eq(schema.scripts.createdBy, userId), gte(schema.scripts.createdAt, since)));
      return n;
    });
  }
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.activityEvents)
    .where(and(eq(schema.activityEvents.actorId, userId), eq(schema.activityEvents.type, `quota.${resource}`), gte(schema.activityEvents.createdAt, since)));
  return n;
}

/** Throws a user-facing error when the daily quota is exhausted. */
export async function assertQuota(userId: string, resource: Resource) {
  const [limit, used] = await Promise.all([dailyLimit(userId, resource), usedToday(userId, resource)]);
  if (limit > 0 && used >= limit) {
    const label = QUOTA_RESOURCES.find((q) => q.key === resource)?.label ?? resource;
    throw new Error(`Daily quota reached: ${label} (${used}/${limit}). Ask an admin to raise it in /admin/quotas.`);
  }
  return { limit, used };
}
