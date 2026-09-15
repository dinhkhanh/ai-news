"use server";
import { revalidatePath } from "next/cache";
import { count, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export async function addDomain(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const domain = str(fd, "domain").toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw new Error("Enter a valid domain, e.g. suzu.group");
    await db
      .insert(schema.allowedDomains)
      .values({ domain, note: str(fd, "note") || null, createdBy: session.user.id })
      .onConflictDoNothing();
    await log("admin.domain.added", { domain });
    revalidatePath("/admin/domains");
    return `Added ${domain}`;
  });
}

export async function removeDomain(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const domain = str(fd, "domain");
    const [{ n }] = await db.select({ n: count() }).from(schema.allowedDomains);
    if (n <= 1) throw new Error("Cannot remove the last allowed domain");
    await db.delete(schema.allowedDomains).where(eq(schema.allowedDomains.domain, domain));
    await log("admin.domain.removed", { domain });
    revalidatePath("/admin/domains");
    return `Removed ${domain}`;
  });
}
