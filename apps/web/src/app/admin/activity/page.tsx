import { and, desc, eq, ilike, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ type?: string; actor?: string; page?: string }> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const pageSize = 100;
  const filters: SQL[] = [];
  if (sp.type) filters.push(ilike(schema.activityEvents.type, `${sp.type}%`));
  if (sp.actor) filters.push(eq(schema.activityEvents.actorId, sp.actor));

  // Admin reads span every workspace: RLS on activity_events only returns rows
  // inside the service context (app.role = service).
  const rows = await withServiceContext((tx) =>
    tx
      .select({
        id: schema.activityEvents.id,
        type: schema.activityEvents.type,
        actorEmail: schema.user.email,
        impersonatorId: schema.activityEvents.impersonatorId,
        organizationId: schema.activityEvents.organizationId,
        projectId: schema.activityEvents.projectId,
        payload: schema.activityEvents.payload,
        ip: schema.activityEvents.ip,
        createdAt: schema.activityEvents.createdAt,
      })
      .from(schema.activityEvents)
      .leftJoin(schema.user, eq(schema.user.id, schema.activityEvents.actorId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(schema.activityEvents.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  );

  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.type) u.set("type", sp.type);
    if (sp.actor) u.set("actor", sp.actor);
    u.set("page", String(p));
    return `/admin/activity?${u}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Activity log</h1>
          <p className="text-sm text-muted-foreground">Append-only. Retention 12 months (configurable later).</p>
        </div>
        <form className="flex gap-2">
          <Input name="type" placeholder="type prefix, e.g. admin." defaultValue={sp.type ?? ""} className="w-56" />
          <Button type="submit" size="sm" variant="outline">
            Filter
          </Button>
          <a href={`/api/admin/activity.csv${sp.type ? `?type=${encodeURIComponent(sp.type)}` : ""}`}>
            <Button type="button" size="sm" variant="ghost">
              Export CSV
            </Button>
          </a>
        </form>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Workspace / project</TableHead>
            <TableHead>Payload</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.createdAt.toISOString().replace("T", " ").slice(0, 19)}</TableCell>
              <TableCell className="font-mono text-xs">{r.type}</TableCell>
              <TableCell className="text-xs">
                {r.actorEmail ?? "system"}
                {r.impersonatorId ? <span className="ml-1 text-amber-600">(impersonated)</span> : null}
              </TableCell>
              <TableCell className="font-mono text-[10px] text-muted-foreground">
                {r.organizationId ?? ""}
                {r.projectId ? ` / ${r.projectId}` : ""}
              </TableCell>
              <TableCell className="max-w-md truncate font-mono text-[10px]">{JSON.stringify(r.payload)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex justify-between text-sm">
        {page > 1 ? <a href={qs(page - 1)}>← Newer</a> : <span />}
        {rows.length === pageSize ? <a href={qs(page + 1)}>Older →</a> : <span />}
      </div>
    </div>
  );
}
