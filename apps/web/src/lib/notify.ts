import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { readSecret } from "@/lib/vault";

/**
 * Operational notifications (docs/PLAN.md §4.9 "Notify"): Slack incoming
 * webhook from /admin/integrations. Never throws; a missing webhook is a no-op.
 */
export async function notifySlack(text: string, blocks?: unknown[]) {
  try {
    const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, "slack_webhook") });
    if (!row?.enabled || !row.vaultRef) return false;
    const url = await readSecret(row.vaultRef);
    if (!url) return false;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, blocks }), signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch (e) {
    console.warn("[notify] slack failed", e);
    return false;
  }
}
