import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { PRIVACY_LABEL, PUB_STATUS_LABEL } from "@/components/publish-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVietnam, PLATFORM_SPEC, type Analytics } from "@/lib/publish/platforms";
import { requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("vi-VN"));

/** Workspace publishing dashboard (docs/PLAN.md §4.10 "analytics pull + dashboard"). */
export default async function PublicationsPage() {
  const ws = await requireWorkspace();
  const rows = await withOrgContext(ws, (tx) =>
    tx
      .select({
        id: schema.publications.id,
        platform: schema.publications.platform,
        status: schema.publications.status,
        privacy: schema.publications.privacy,
        scheduledAt: schema.publications.scheduledAt,
        publishedAt: schema.publications.publishedAt,
        platformUrl: schema.publications.platformUrl,
        analyticsJson: schema.publications.analyticsJson,
        analyticsAt: schema.publications.analyticsAt,
        error: schema.publications.error,
        projectId: schema.publications.projectId,
        projectTitle: schema.projects.title,
        channelName: schema.channels.name,
        createdByName: schema.user.name,
        createdAt: schema.publications.createdAt,
      })
      .from(schema.publications)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.publications.projectId))
      .leftJoin(schema.channels, eq(schema.channels.id, schema.publications.channelId))
      .leftJoin(schema.user, eq(schema.user.id, schema.publications.createdBy))
      .orderBy(desc(schema.publications.createdAt))
      .limit(200),
  );
  const published = rows.filter((r) => r.status === "published");
  const totals = { views: 0, likes: 0, comments: 0, shares: 0 };
  const perPlatform = new Map<string, { posts: number; views: number }>();
  for (const r of published) {
    const a = r.analyticsJson as unknown as Analytics | null;
    totals.views += a?.views ?? 0;
    totals.likes += a?.likes ?? 0;
    totals.comments += a?.comments ?? 0;
    totals.shares += a?.shares ?? 0;
    const p = perPlatform.get(r.platform) ?? { posts: 0, views: 0 };
    p.posts++;
    p.views += a?.views ?? 0;
    perPlatform.set(r.platform, p);
  }
  const active = rows.some((r) => r.status === "publishing" || r.status === "processing");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <AutoRefresh active={active} everyMs={15000} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Đã đăng</h1>
        <p className="text-sm text-muted-foreground">Workspace: {ws.name} · số liệu được kéo về hằng ngày lúc 02:30 (giờ Việt Nam).</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Bài đã đăng", String(published.length)],
          ["Lượt xem", n(totals.views)],
          ["Thích", n(totals.likes)],
          ["Bình luận", n(totals.comments)],
          ["Chia sẻ", n(totals.shares)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold tabular-nums">{value}</CardContent>
          </Card>
        ))}
      </div>
      {perPlatform.size ? (
        <div className="flex flex-wrap gap-2 text-xs">
          {[...perPlatform.entries()].map(([p, v]) => (
            <Badge key={p} variant="outline">
              {PLATFORM_SPEC[p as keyof typeof PLATFORM_SPEC]?.label ?? p}: {v.posts} bài · {n(v.views)} lượt xem
            </Badge>
          ))}
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lượt đăng</CardTitle>
          <CardDescription>Mới nhất trước. Mở dự án để huỷ lịch, thử lại hoặc đăng lên kênh khác.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có lượt đăng nào.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dự án</TableHead>
                  <TableHead>Kênh</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Thời gian</TableHead>
                  <TableHead className="text-right">Xem</TableHead>
                  <TableHead className="text-right">Thích</TableHead>
                  <TableHead className="text-right">BL</TableHead>
                  <TableHead className="text-right">Chia sẻ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const a = r.analyticsJson as unknown as Analytics | null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-64 truncate">
                        {r.projectId ? (
                          <Link href={`/app/projects/${r.projectId}`} className="underline">
                            {r.projectTitle ?? r.projectId}
                          </Link>
                        ) : (
                          (r.projectTitle ?? "—")
                        )}
                        <div className="text-xs text-muted-foreground">{r.createdByName ?? ""}</div>
                      </TableCell>
                      <TableCell>
                        {PLATFORM_SPEC[r.platform].label}
                        <div className="text-xs text-muted-foreground">
                          {r.channelName} · {PRIVACY_LABEL[r.privacy] ?? r.privacy}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.status === "published" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{PUB_STATUS_LABEL[r.status] ?? r.status}</Badge>
                        {r.platformUrl ? (
                          <div>
                            <a href={r.platformUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                              mở bài đăng
                            </a>
                          </div>
                        ) : null}
                        {r.error ? <div className="max-w-56 truncate text-xs text-destructive" title={r.error}>{r.error}</div> : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.publishedAt ? formatVietnam(r.publishedAt) : r.status === "scheduled" && r.scheduledAt ? `lịch ${formatVietnam(r.scheduledAt)}` : formatVietnam(r.createdAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(a?.views)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(a?.likes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(a?.comments)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(a?.shares)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
