import "server-only";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { FEATURE_FLAGS } from "@/lib/integrations";

export type FlagKey = (typeof FEATURE_FLAGS)[number]["key"];

/** Feature flags from /admin/integrations. Unknown / unset flags are off. */
export async function flagsEnabled(keys: FlagKey[]): Promise<Record<string, boolean>> {
  if (keys.length === 0) return {};
  const rows = await db.select({ key: schema.featureFlags.key, enabled: schema.featureFlags.enabled }).from(schema.featureFlags).where(inArray(schema.featureFlags.key, keys));
  const out: Record<string, boolean> = Object.fromEntries(keys.map((k) => [k, false]));
  for (const r of rows) out[r.key] = r.enabled;
  return out;
}

export async function flagEnabled(key: FlagKey) {
  return (await flagsEnabled([key]))[key] ?? false;
}
