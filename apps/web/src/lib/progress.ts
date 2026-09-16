import "server-only";
import { eq, sql } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";

type Ctx = { userId: string; organizationId: string; projectId: string };

/**
 * Live progress for the running pipeline step (projects.busy_progress). The
 * Inngest functions call `reportProgress` at the top of each step and
 * `tickProgress` from parallel steps; the page polls it through
 * /api/projects/status. Every write also bumps updated_at, so a long step
 * stays "not stale" as long as it reports.
 *
 * Calls sit *inside* `step.run` bodies: code outside a step re-runs on every
 * Inngest replay and would rewrite stale labels.
 */
export async function reportProgress(ctx: Ctx, p: { label: string; pct?: number | null; total?: number }) {
  const now = new Date().toISOString();
  const patch = JSON.stringify({ label: p.label, pct: p.pct ?? null, at: now, done: 0, total: p.total ?? null });
  await withOrgContext(ctx, (tx) =>
    tx
      .update(schema.projects)
      .set({
        busyProgress: sql`jsonb_build_object('startedAt', coalesce(${schema.projects.busyProgress}->>'startedAt', ${now}::text)) || coalesce(${schema.projects.busyProgress}, '{}'::jsonb) || ${patch}::jsonb`,
      })
      .where(eq(schema.projects.id, ctx.projectId)),
  ).catch((e) => console.warn("[progress] report failed", e));
}

/**
 * Atomic "one more done" for parallel steps: label becomes "<label> done/total"
 * and pct moves linearly from `from` to `to`. Row-level locking serialises
 * concurrent ticks, so the counter is exact.
 */
export async function tickProgress(ctx: Ctx, p: { label: string; total: number; from: number; to: number }) {
  const now = new Date().toISOString();
  const total = Math.max(1, Math.floor(p.total));
  const done = sql`least(coalesce((${schema.projects.busyProgress}->>'done')::int, 0) + 1, ${total}::int)`;
  await withOrgContext(ctx, (tx) =>
    tx
      .update(schema.projects)
      .set({
        busyProgress: sql`coalesce(${schema.projects.busyProgress}, '{}'::jsonb) || jsonb_build_object(
          'done', ${done},
          'total', ${total}::int,
          'label', ${p.label}::text || ' ' || (${done})::text || '/' || ${total}::text,
          'pct', round(${p.from}::float + (${p.to}::float - ${p.from}::float) * (${done})::float / ${total}::float),
          'at', ${now}::text
        )`,
      })
      .where(eq(schema.projects.id, ctx.projectId)),
  ).catch((e) => console.warn("[progress] tick failed", e));
}
