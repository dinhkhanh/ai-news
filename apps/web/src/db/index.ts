import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";


/**
 * Pooled connection (Supavisor transaction mode) for request-time queries.
 * `prepare: false` is required for transaction-mode poolers.
 *
 * `max_pipeline: 0` is required too: postgres.js otherwise pipelines a query onto a connection that
 * still waits for an earlier reply once the pool is busy, and Supavisor can hand the two halves of
 * that pipeline to different backends. The second reply never arrives, the query never settles and
 * the page hangs forever (porsager/postgres#970). A pipeline only starts behind a parameterless query,
 * which is why it hit some pages and not others. With 0 the driver queues instead; `patches/postgres@*.patch`
 * keeps `sql.begin` working with that setting, so carry the patch over when upgrading `postgres`.
 */
const globalForDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> };

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export const sql =
  globalForDb.__sql ??
  postgres(connectionString(), {
    prepare: false,
    // One query per connection now, so a page's parallel queries need a few more of them.
    max: process.env.NODE_ENV === "production" ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // A real postgres.js option that its type definitions leave out.
    ...({ max_pipeline: 0 } as object),
  });
if (process.env.NODE_ENV !== "production") globalForDb.__sql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type Db = typeof db;
export { schema };
