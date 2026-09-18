import { sql } from "drizzle-orm";
import { db } from "@/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

type Stats = {
  users: number;
  orgs: number;
  projects: number;
  renders: number;
  events: number;
  spendUsd: number;
  byProvider: Array<{ provider: string; usd: number }>;
};

/** One round-trip: `admin_overview_stats()` (migration 0010) aggregates every tile server-side. */
async function loadStats(): Promise<Stats> {
  // Raw `sql` params skip Drizzle's column mappers, so a Date must be sent as text and cast.
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rows = await db.execute<{ stats: Stats }>(sql`select admin_overview_stats(${since}::timestamptz) as stats`);
  return rows[0].stats;
}

export default async function AdminOverview() {
  // The layout's check is not enough: a request for this segment alone renders the page without the layout.
  await requireAdmin();
  const s = await loadStats();

  const tiles: Array<[string, string | number]> = [
    ["Users", s.users],
    ["Workspaces", s.orgs],
    ["Projects", s.projects],
    ["Renders", s.renders],
    ["Activity events (30 d)", s.events],
    ["Spend (30 d)", `$${Number(s.spendUsd ?? 0).toFixed(2)}`],
  ];
  return (
    <div className="space-y-6">
      <h1 className="sr-only">Overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-[1.375rem] font-medium tabular-nums">{value}</CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Spend by provider (30 d)</CardTitle>
        </CardHeader>
        <CardContent>
          {s.byProvider.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {s.byProvider.map((r) => (
                  <tr key={r.provider} className="border-t">
                    <td className="py-1.5">{r.provider}</td>
                    <td className="py-1.5 text-right tabular-nums">${Number(r.usd).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
