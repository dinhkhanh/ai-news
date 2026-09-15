"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { PLATFORM_ROLES } from "@/lib/permissions";

export async function setPlatformRole(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { headers, log, session } = await assertAdmin();
    const userId = str(fd, "userId");
    const role = str(fd, "role");
    if (!(PLATFORM_ROLES as readonly string[]).includes(role)) throw new Error("Unknown role");
    if (userId === session.user.id && role !== "admin") throw new Error("You cannot demote yourself");
    await auth.api.setRole({ headers, body: { userId, role: role as "user" | "admin" } });
    await log("admin.user.role_set", { userId, role });
    revalidatePath("/admin/users");
    return `Role set to ${role}`;
  });
}

export async function banUser(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { headers, log, session } = await assertAdmin();
    const userId = str(fd, "userId");
    if (userId === session.user.id) throw new Error("You cannot ban yourself");
    const banReason = str(fd, "reason") || "Banned by admin";
    await auth.api.banUser({ headers, body: { userId, banReason } });
    await log("admin.user.banned", { userId, banReason });
    revalidatePath("/admin/users");
    return "User banned";
  });
}

export async function unbanUser(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { headers, log } = await assertAdmin();
    const userId = str(fd, "userId");
    await auth.api.unbanUser({ headers, body: { userId } });
    await log("admin.user.unbanned", { userId });
    revalidatePath("/admin/users");
    return "User unbanned";
  });
}

export async function impersonate(fd: FormData) {
  const { headers, log } = await assertAdmin();
  const userId = str(fd, "userId");
  await auth.api.impersonateUser({ headers, body: { userId } });
  await log("admin.user.impersonation_started", { userId });
  redirect("/app");
}
