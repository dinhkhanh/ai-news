import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadAdminQuotas } from "@/lib/admin-data";
import { QUOTA_RESOURCES } from "@/lib/integrations";
import { deleteQuota, saveQuota } from "./actions";

export const dynamic = "force-dynamic";

export default async function QuotasPage() {
  const { quotas: rows, users, orgs } = await loadAdminQuotas();
  const defaults = rows.filter((r) => r.scopeId === "*");
  const overrides = rows.filter((r) => r.scopeId !== "*");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Quotas</h1>
        <p className="text-sm text-muted-foreground">Daily limits. Overrides for a specific user or workspace beat the scope default.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Defaults per user / day</CardTitle>
          <CardDescription>Plan §9: 20 scripts, 5 AI media, 30 render minutes, 10 publishes.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {QUOTA_RESOURCES.map((r) => {
            const current = defaults.find((d) => d.scope === "user" && d.resource === r.key);
            return (
              <ActionForm key={r.key} action={saveQuota} className="flex items-end gap-2">
                <input type="hidden" name="scope" value="user" />
                <input type="hidden" name="scopeId" value="*" />
                <input type="hidden" name="resource" value={r.key} />
                <div className="flex-1 space-y-1">
                  <label className="text-sm">{r.label}</label>
                  <Input name="dailyLimit" type="number" min="0" defaultValue={current?.dailyLimit ?? r.defaultUser} />
                </div>
                <Button type="submit" size="sm" variant="outline">
                  Save
                </Button>
              </ActionForm>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add override</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveQuota} className="grid gap-2 md:grid-cols-5" resetOnSuccess>
            <select name="scope" className="h-9 rounded-md border bg-background px-2 text-sm">
              <option value="user">user</option>
              <option value="org">workspace</option>
            </select>
            <select name="scopeId" className="h-9 rounded-md border bg-background px-2 text-sm">
              <optgroup label="Users">
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Workspaces">
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <select name="resource" className="h-9 rounded-md border bg-background px-2 text-sm">
              {QUOTA_RESOURCES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <Input name="dailyLimit" type="number" min="0" placeholder="Limit" required />
            <Button type="submit" size="sm">
              Add
            </Button>
          </ActionForm>
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead className="text-right">Daily limit</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {overrides.map((q) => (
            <TableRow key={q.id}>
              <TableCell>{q.scope}</TableCell>
              <TableCell className="font-mono text-xs">
                {users.find((u) => u.id === q.scopeId)?.email ?? orgs.find((o) => o.id === q.scopeId)?.name ?? q.scopeId}
              </TableCell>
              <TableCell>{q.resource}</TableCell>
              <TableCell className="text-right tabular-nums">{q.dailyLimit}</TableCell>
              <TableCell className="text-right">
                <ActionForm action={deleteQuota}>
                  <input type="hidden" name="id" value={q.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    Remove
                  </Button>
                </ActionForm>
              </TableCell>
            </TableRow>
          ))}
          {overrides.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                No overrides.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
