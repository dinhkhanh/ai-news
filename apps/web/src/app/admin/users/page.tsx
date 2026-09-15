import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getSession } from "@/lib/session";
import { banUser, impersonate, setPlatformRole, unbanUser } from "./actions";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await getSession();
  const users = await db.select().from(schema.user).orderBy(desc(schema.user.createdAt)).limit(500);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Platform role <code>admin</code> unlocks this CMS. Workspace roles (viewer/editor/publisher/admin) are set per workspace.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Domain</TableHead>
            <TableHead>Platform role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last login</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const isMe = u.id === me?.user.id;
            return (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">{u.domain}</TableCell>
                <TableCell>
                  <ActionForm action={setPlatformRole} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <select name="role" defaultValue={u.role} className="h-8 rounded-md border bg-background px-2 text-sm" disabled={isMe}>
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                    {!isMe ? (
                      <Button type="submit" size="sm" variant="outline">
                        Set
                      </Button>
                    ) : null}
                  </ActionForm>
                </TableCell>
                <TableCell>{u.banned ? <Badge variant="destructive">banned</Badge> : <Badge variant="secondary">active</Badge>}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{u.lastLogin ? u.lastLogin.toISOString().replace("T", " ").slice(0, 16) : "—"}</TableCell>
                <TableCell>
                  {!isMe ? (
                    <div className="flex justify-end gap-2">
                      {u.banned ? (
                        <ActionForm action={unbanUser}>
                          <input type="hidden" name="userId" value={u.id} />
                          <Button type="submit" size="sm" variant="outline">
                            Unban
                          </Button>
                        </ActionForm>
                      ) : (
                        <ActionForm action={banUser} className="flex gap-1">
                          <input type="hidden" name="userId" value={u.id} />
                          <Input name="reason" placeholder="Reason" className="h-8 w-32" />
                          <Button type="submit" size="sm" variant="destructive">
                            Ban
                          </Button>
                        </ActionForm>
                      )}
                      <form action={impersonate}>
                        <input type="hidden" name="userId" value={u.id} />
                        <Button type="submit" size="sm" variant="ghost">
                          Impersonate
                        </Button>
                      </form>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">you</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
