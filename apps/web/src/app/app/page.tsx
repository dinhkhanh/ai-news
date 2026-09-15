import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/session";

export default async function AppHome() {
  const session = await requireSession();
  const activeOrgId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  const memberships = await db
    .select({
      orgId: schema.organization.id,
      name: schema.organization.name,
      kind: schema.organization.kind,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, session.user.id));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Xin chào, {session.user.name}</h1>
        <p className="text-sm text-muted-foreground">Phase 1: nền tảng. Tạo dự án sẽ có ở phase 2.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Mỗi người có một workspace cá nhân. Workspace nhóm sẽ đến sau.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {memberships.map((m) => (
            <div key={m.orgId} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{m.name}</div>
                <div className="text-xs text-muted-foreground">{m.kind}</div>
              </div>
              <div className="flex items-center gap-2">
                {m.orgId === activeOrgId ? <Badge>active</Badge> : null}
                <Badge variant="secondary">{m.role}</Badge>
              </div>
            </div>
          ))}
          {memberships.length === 0 ? <p className="text-sm text-muted-foreground">No workspace yet.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
