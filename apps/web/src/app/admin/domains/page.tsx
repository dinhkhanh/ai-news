import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addDomain, removeDomain } from "./actions";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
  // The layout's check is not enough: a request for this segment alone renders the page without the layout.
  await requireAdmin();
  const rows = await db.select().from(schema.allowedDomains).orderBy(asc(schema.allowedDomains.domain));
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="sr-only">Allowed sign-in domains</h1>
        <p className="text-sm text-muted-foreground">
          Only Google Workspace accounts from these domains can sign in. Existing users lose access when their domain is removed.
        </p>
      </div>
      <ActionForm action={addDomain} resetOnSuccess className="flex gap-2">
        <Input name="domain" placeholder="example.com" required className="max-w-xs" />
        <Input name="note" placeholder="Note (optional)" className="max-w-xs" />
        <Button type="submit">Add</Button>
      </ActionForm>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            <TableHead>Note</TableHead>
            <TableHead>Added</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.domain}>
              <TableCell className="font-mono">{r.domain}</TableCell>
              <TableCell>{r.note}</TableCell>
              <TableCell className="text-muted-foreground">{r.createdAt.toISOString().slice(0, 10)}</TableCell>
              <TableCell className="text-right">
                <ActionForm action={removeDomain}>
                  <input type="hidden" name="domain" value={r.domain} />
                  <Button type="submit" size="sm" variant="ghost">
                    Remove
                  </Button>
                </ActionForm>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
