"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "@/db";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { ORG_ROLE_NAMES } from "@/lib/permissions";

export async function setMemberRole(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const organizationId = str(fd, "organizationId");
    const userId = str(fd, "userId");
    const role = str(fd, "role");
    if (!(ORG_ROLE_NAMES as string[]).includes(role)) throw new Error("Unknown workspace role");
    const existing = await db.query.member.findFirst({
      where: and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)),
    });
    if (existing?.role === "owner") throw new Error("The workspace owner keeps the owner role");
    if (existing) {
      await db.update(schema.member).set({ role }).where(eq(schema.member.id, existing.id));
    } else {
      await db.insert(schema.member).values({ id: nanoid(), organizationId, userId, role });
    }
    await log("admin.workspace.member_role_set", { userId, role }, { organizationId });
    revalidatePath("/admin/workspaces");
    return `Role set to ${role}`;
  });
}

export async function removeMember(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const organizationId = str(fd, "organizationId");
    const userId = str(fd, "userId");
    const existing = await db.query.member.findFirst({
      where: and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)),
    });
    if (!existing) throw new Error("Not a member");
    if (existing.role === "owner") throw new Error("Cannot remove the owner");
    await db.delete(schema.member).where(eq(schema.member.id, existing.id));
    await log("admin.workspace.member_removed", { userId }, { organizationId });
    revalidatePath("/admin/workspaces");
    return "Member removed";
  });
}
