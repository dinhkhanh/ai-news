import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";

export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/?next=" + encodeURIComponent("/app"));
  return session;
}

export async function requireAdmin() {
  const session = await requireSession();
  if (session.user.role !== "admin") redirect("/app?error=forbidden");
  return session;
}

export function isPlatformAdmin(session: { user: { role?: string | null } } | null) {
  return session?.user.role === "admin";
}
