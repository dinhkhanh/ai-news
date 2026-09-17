import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadAdminAnalytics } from "@/lib/admin-data";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { dayStart } from "@/lib/quota";

export const dynamic = "force-dynamic";

const n = (v: number | string | null | undefined) => (v == null ? "—" : Number(v).toLocaleString("en-US"));

/** One round-trip: `admin_analytics_stats()` (migration 0013) aggregates every tile and table. */
function loadStats() {
  return loadAdminAnalytics(new Date(Date.now() - 30 * 24 * 3600 * 1000), dayStart());
}

/** Admin analytics (docs/PLAN.md §6 "produced, published, platform performance"; §7 YouTube quota). */
export default async function AnalyticsPage() {
  const { produced, published, byPlatform, byDay, byStatus: statusMap, ytUnitsToday, topPosts, channels, unhealthyChannels } = await loadStats();
  const tiles: Array<[string, string]> = [
    ["Renders done (30 d)", n(produced)],
    ["Published (30 d)", n(published)],
    ["Scheduled / processing", n((statusMap.scheduled ?? 0) + (statusMap.publishing ?? 0) + (statusMap.processing ?? 0))],
    ["Failed (30 d)", n(statusMap.failed ?? 0)],
    ["YouTube quota today", `${n(ytUnitsToday)} / 10,000`],
    ["Channels", `${channels} (${unhealthyChannels} unhealthy)`],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Analytics</h1>
        <p className="text-sm text-muted-foreground">Produced vs published, platform performance from the daily analytics pull, YouTube Data API units used today (1,600 per upload; default quota 10,000/day).</p>
      </div>
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
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">By platform (30 d)</CardTitle>
          </CardHeader>
          <CardContent>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing published yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead className="text-right">Posts</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Likes</TableHead>
                    <TableHead className="text-right">Comments</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byPlatform.map((r) => (
                    <TableRow key={r.platform}>
                      <TableCell>{PLATFORM_SPEC[r.platform].label}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(r.posts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(r.views)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(r.likes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(r.comments)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(r.shares)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Top posts (30 d, by views)</CardTitle>
          </CardHeader>
          <CardContent>
            {topPosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No analytics yet.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {topPosts.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="max-w-72 truncate py-1.5">
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noreferrer" className="underline">
                            {p.title ?? p.id}
                          </a>
                        ) : (
                          (p.title ?? p.id)
                        )}
                      </td>
                      <td className="py-1.5 text-xs text-muted-foreground">{PLATFORM_SPEC[p.platform].label}</td>
                      <td className="py-1.5 text-right tabular-nums">{n(p.views)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Published per day (Asia/Ho_Chi_Minh)</CardTitle>
          <CardDescription>Last 30 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {byDay.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing published yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {byDay.map((d) => (
                  <tr key={d.day} className="border-t">
                    <td className="py-1.5">{d.day}</td>
                    <td className="py-1.5 text-right tabular-nums">{n(d.posts)} posts</td>
                    <td className="py-1.5 text-right tabular-nums">{n(d.views)} views</td>
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
