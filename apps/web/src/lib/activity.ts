import "server-only";
import { db, schema } from "@/db";

export type ActivityInput = {
  actorId?: string | null;
  impersonatorId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Append-only activity log. Never throws: a logging failure must not break
 * the user action. Errors are reported to console (and Sentry once wired).
 */
export async function logActivity(input: ActivityInput) {
  try {
    await db.insert(schema.activityEvents).values({
      actorId: input.actorId ?? null,
      impersonatorId: input.impersonatorId ?? null,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (err) {
    console.error("[activity] failed to log", input.type, err);
  }
}

export type UsageCostInput = {
  provider: string;
  resource?: string;
  units: number;
  unitType: string;
  costUsd: number;
  userId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  renderId?: string | null;
  meta?: Record<string, unknown>;
};

export async function recordUsageCost(input: UsageCostInput) {
  try {
    await db.insert(schema.usageCosts).values({
      provider: input.provider,
      resource: input.resource ?? null,
      units: input.units.toFixed(4),
      unitType: input.unitType,
      costUsd: input.costUsd.toFixed(6),
      userId: input.userId ?? null,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
      renderId: input.renderId ?? null,
      meta: input.meta ?? {},
    });
  } catch (err) {
    console.error("[usage] failed to record", input.provider, err);
  }
}
