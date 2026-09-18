import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { loadAdminWorkspaces } from "@/lib/admin-data";
import { ORG_ROLE_NAMES } from "@/lib/permissions";
import { removeMember, setMemberRole } from "./actions";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  // The layout's check is not enough: a request for this segment alone renders the page without the layout.
  await requireAdmin();
  const { orgs, members, users } = await loadAdminWorkspaces();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="sr-only">Workspaces</h1>
        <p className="text-sm text-muted-foreground">
          One personal workspace per user is created on first sign-in. Team workspaces come in phase 6; members can still be added here
          for testing.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {orgs.map((o) => {
          const ms = members.filter((m) => m.organizationId === o.id);
          return (
            <Card key={o.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{o.name}</CardTitle>
                  <Badge variant="secondary">{o.kind}</Badge>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">{o.id}</div>
              </CardHeader>
              <CardContent className="space-y-2">
                {ms.map((m) => (
                  <div key={m.userId} className="flex items-center justify-between gap-2 text-sm">
                    <div className="truncate">
                      {m.name} <span className="text-xs text-muted-foreground">{m.email}</span>
                    </div>
                    {m.role === "owner" ? (
                      <Badge>owner</Badge>
                    ) : (
                      <div className="flex items-center gap-1">
                        <ActionForm action={setMemberRole} className="flex items-center gap-1">
                          <input type="hidden" name="organizationId" value={o.id} />
                          <input type="hidden" name="userId" value={m.userId} />
                          <NativeSelect name="role" defaultValue={m.role} fieldSize="sm">
                            {ORG_ROLE_NAMES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </NativeSelect>
                          <Button type="submit" size="sm" variant="outline">
                            Set
                          </Button>
                        </ActionForm>
                        <ActionForm action={removeMember}>
                          <input type="hidden" name="organizationId" value={o.id} />
                          <input type="hidden" name="userId" value={m.userId} />
                          <Button type="submit" size="sm" variant="ghost">
                            ✕
                          </Button>
                        </ActionForm>
                      </div>
                    )}
                  </div>
                ))}
                <ActionForm action={setMemberRole} className="flex items-center gap-1 border-t pt-2" resetOnSuccess>
                  <input type="hidden" name="organizationId" value={o.id} />
                  <NativeSelect name="userId" fieldSize="sm" className="flex-1">
                    {users
                      .filter((u) => !ms.some((m) => m.userId === u.id))
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.email}
                        </option>
                      ))}
                  </NativeSelect>
                  <NativeSelect name="role" defaultValue="editor" fieldSize="sm">
                    {ORG_ROLE_NAMES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button type="submit" size="sm" variant="outline">
                    Add
                  </Button>
                </ActionForm>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
