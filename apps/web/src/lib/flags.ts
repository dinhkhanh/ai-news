import "server-only";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { flagDefault, type FEATURE_FLAGS } from "@/lib/integrations";

export type FlagKey = (typeof FEATURE_FLAGS)[number]["key"];

/** Feature flags from /admin/integrations. An unset flag takes its catalogue default (off, except `defaultOn` flags such as `face_guard` and `web_video_downloader`). */
export async function flagsEnabled(keys: FlagKey[]): Promise<Record<string, boolean>> {
  if (keys.length === 0) return {};
  const rows = await db.select({ key: schema.featureFlags.key, enabled: schema.featureFlags.enabled }).from(schema.featureFlags).where(inArray(schema.featureFlags.key, keys));
  const out: Record<string, boolean> = Object.fromEntries(keys.map((k) => [k, flagDefault(k)]));
  for (const r of rows) out[r.key] = r.enabled;
  return out;
}

export async function flagEnabled(key: FlagKey) {
  return (await flagsEnabled([key]))[key] ?? flagDefault(key);
}
