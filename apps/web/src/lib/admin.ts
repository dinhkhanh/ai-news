import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export type ActionState = { ok: boolean; message?: string };
export const idle: ActionState = { ok: false };

/** For server actions: returns the admin session or throws. */
export async function assertAdmin() {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session || session.user.role !== "admin") throw new Error("Forbidden");
  return {
    session,
    headers: h,
    log: (type: string, payload?: Record<string, unknown>, extra?: { organizationId?: string; projectId?: string }) =>
      logActivity({
        actorId: session.user.id,
        impersonatorId: (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
        type,
        payload,
        organizationId: extra?.organizationId,
        projectId: extra?.projectId,
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: h.get("user-agent"),
      }),
  };
}

/** Wrap an action body so thrown errors become a state instead of a 500. */
export async function run(body: () => Promise<string | void>): Promise<ActionState> {
  try {
    const message = await body();
    return { ok: true, message: message ?? "Saved" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong" };
  }
}

export const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
export const num = (fd: FormData, key: string) => {
  const v = Number(fd.get(key));
  if (!Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
};
