import "server-only";
import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { db, schema } from "./index";

export type Tx = PgTransaction<PostgresJsQueryResultHKT, typeof schema, Record<string, never>>;

/**
 * Run `fn` inside a transaction with the RLS context set:
 *   app.user_id  – acting user
 *   app.org_id   – active workspace
 * Row-level policies on org-scoped tables compare organization_id to app.org_id.
 */
export async function withOrgContext<T>(
  ctx: { userId: string; organizationId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.org_id', ${ctx.organizationId}, true), set_config('app.role', 'user', true)`,
    );
    return fn(tx as unknown as Tx);
  });
}

/**
 * Service context bypasses org scoping (admin CMS, background jobs that
 * span workspaces). Only ever used server-side.
 */
export async function withServiceContext<T>(fn: (tx: Tx) => Promise<T>, actingUserId?: string): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${actingUserId ?? ""}, true), set_config('app.org_id', '', true), set_config('app.role', 'service', true)`,
    );
    return fn(tx as unknown as Tx);
  });
}
