"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertAdmin, num, run, str, type ActionState } from "@/lib/admin";
import { QUOTA_RESOURCES } from "@/lib/integrations";

export async function saveQuota(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const scope = str(fd, "scope") as "user" | "org";
    if (scope !== "user" && scope !== "org") throw new Error("Unknown scope");
    const scopeId = str(fd, "scopeId") || "*";
    const resource = str(fd, "resource");
    if (!QUOTA_RESOURCES.some((r) => r.key === resource)) throw new Error("Unknown resource");
    const dailyLimit = Math.max(0, Math.trunc(num(fd, "dailyLimit")));
    await db
      .insert(schema.quotas)
      .values({ scope, scopeId, resource, dailyLimit, updatedBy: session.user.id })
      .onConflictDoUpdate({
        target: [schema.quotas.scope, schema.quotas.scopeId, schema.quotas.resource],
        set: { dailyLimit, updatedBy: session.user.id, updatedAt: new Date() },
      });
    await log("admin.quota.saved", { scope, scopeId, resource, dailyLimit });
    revalidatePath("/admin/quotas");
    return `Quota saved: ${scope}/${scopeId}/${resource} = ${dailyLimit}`;
  });
}

export async function deleteQuota(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const id = str(fd, "id");
    const row = await db.query.quotas.findFirst({ where: eq(schema.quotas.id, id) });
    if (!row) throw new Error("Not found");
    if (row.scopeId === "*") throw new Error("Defaults cannot be deleted, edit them instead");
    await db.delete(schema.quotas).where(and(eq(schema.quotas.id, id)));
    await log("admin.quota.deleted", { scope: row.scope, scopeId: row.scopeId, resource: row.resource });
    revalidatePath("/admin/quotas");
    return "Override removed";
  });
}
