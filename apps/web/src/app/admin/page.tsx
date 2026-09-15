import { count, desc, gte, sql, sum } from "drizzle-orm";
import { db, schema } from "@/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

async function loadStats() {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [[users], [orgs], [projects], [renders], [events], [costs], recent] = await Promise.all([
    db.select({ n: count() }).from(schema.user),
    db.select({ n: count() }).from(schema.organization),
    db.select({ n: count() }).from(schema.projects),
    db.select({ n: count() }).from(schema.renders),
    db.select({ n: count() }).from(schema.activityEvents).where(gte(schema.activityEvents.createdAt, since)),
    db.select({ usd: sum(schema.usageCosts.costUsd) }).from(schema.usageCosts).where(gte(schema.usageCosts.createdAt, since)),
    db
      .select({
        provider: schema.usageCosts.provider,
        usd: sql<string>`coalesce(sum(${schema.usageCosts.costUsd}), 0)`,
      })
      .from(schema.usageCosts)
      .where(gte(schema.usageCosts.createdAt, since))
      .groupBy(schema.usageCosts.provider)
      .orderBy(desc(sql`sum(${schema.usageCosts.costUsd})`)),
  ]);
  return { users, orgs, projects, renders, events, costs, recent };
}

export default async function AdminOverview() {
  const { users, orgs, projects, renders, events, costs, recent } = await loadStats();

  const tiles: Array<[string, string | number]> = [
    ["Users", users.n],
    ["Workspaces", orgs.n],
    ["Projects", projects.n],
    ["Renders", renders.n],
    ["Activity events (30 d)", events.n],
    ["Spend (30 d)", `$${Number(costs.usd ?? 0).toFixed(2)}`],
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">{value}</CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Spend by provider (30 d)</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {recent.map((r) => (
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
