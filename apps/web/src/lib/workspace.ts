import "server-only";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { auth } from "@/lib/auth";
import type { OrgRole } from "@/lib/permissions";
import { getSession, requireSession } from "@/lib/session";

export type Workspace = {
  userId: string;
  organizationId: string;
  role: OrgRole;
  name: string;
  isAdmin: boolean;
};

const WRITE_ROLES: OrgRole[] = ["editor", "publisher", "admin", "owner"];

/** Active workspace for the signed-in user (pages). Redirects when signed out. */
export async function requireWorkspace(): Promise<Workspace> {
  const session = await requireSession();
  return resolveWorkspace(session.user.id, session.user.role, (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null);
}

/** Active workspace for route handlers: null when signed out (no redirect). */
export async function getWorkspace(): Promise<Workspace | null> {
  const session = await getSession();
  if (!session) return null;
  try {
    return await resolveWorkspace(session.user.id, session.user.role, (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null);
  } catch {
    return null;
  }
}

async function resolveWorkspace(userId: string, platformRole: string | null | undefined, activeOrgId: string | null): Promise<Workspace> {
  const memberships = await db
    .select({ orgId: schema.member.organizationId, role: schema.member.role, name: schema.organization.name })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId));
  const m = memberships.find((x) => x.orgId === activeOrgId) ?? memberships[0];
  if (!m) throw new Error("You are not a member of any workspace yet. Sign out and in again.");
  return { userId, organizationId: m.orgId, role: m.role as OrgRole, name: m.name, isAdmin: platformRole === "admin" };
}

export function canWrite(ws: Workspace) {
  return ws.isAdmin || WRITE_ROLES.includes(ws.role);
}

/** For server actions: workspace + a logger bound to the actor, or throws. */
export async function assertWorkspaceWriter() {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) throw new Error("Not signed in");
  const ws = await resolveWorkspace(session.user.id, session.user.role, (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null);
  if (!canWrite(ws)) throw new Error("Your workspace role cannot edit projects");
  const impersonatorId = (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? null;
  return {
    ws,
    session,
    log: (type: string, payload?: Record<string, unknown>, projectId?: string) =>
      logActivity({
        actorId: ws.userId,
        impersonatorId,
        organizationId: ws.organizationId,
        projectId,
        type,
        payload,
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: h.get("user-agent"),
      }),
  };
}

export async function memberRole(userId: string, organizationId: string) {
  const m = await db.query.member.findFirst({ where: and(eq(schema.member.userId, userId), eq(schema.member.organizationId, organizationId)) });
  return (m?.role as OrgRole | undefined) ?? null;
}
