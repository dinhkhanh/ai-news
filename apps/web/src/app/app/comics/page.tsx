import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { BookOpen, ChevronRight, Plus } from "lucide-react";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUsd } from "@/lib/comic/models";
import { dailyLimit, usedToday } from "@/lib/quota";
import { timeAgo } from "@/lib/time";
import { canWrite } from "@/lib/workspace";
import { ComicTabs } from "./comic-tabs";
import { requireComicsWorkspace } from "./guard";
import { COMIC_STATE_LABEL } from "./labels";

export const metadata: Metadata = { title: "Truyện tranh" };

export const dynamic = "force-dynamic";

/** Comic studio home (docs/COMIC.md §10): the workspace's comics, newest first. */
export default async function ComicsPage() {
  const ws = await requireComicsWorkspace();
  const writer = canWrite(ws);
  const [rows, limit, used] = await Promise.all([
    withOrgContext(ws, (tx) =>
      tx
        .select({
          id: schema.comics.id,
          title: schema.comics.title,
          state: schema.comics.state,
          busyStep: schema.comics.busyStep,
          format: schema.comics.format,
          costUsd: schema.comics.costUsd,
          createdAt: schema.comics.createdAt,
          style: schema.comicStyles.name,
          ownerName: schema.user.name,
        })
        .from(schema.comics)
        .leftJoin(schema.comicStyles, eq(schema.comicStyles.id, schema.comics.styleId))
        .leftJoin(schema.user, eq(schema.user.id, schema.comics.ownerId))
        .where(eq(schema.comics.organizationId, ws.organizationId))
        .orderBy(desc(schema.comics.createdAt))
        .limit(100),
    ),
    dailyLimit(ws.userId, "comic_images"),
    usedToday(ws.userId, "comic_images"),
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-6">
      <AutoRefresh active={rows.some((r) => r.busyStep)} everyMs={6000} />
      <ComicTabs active="comics" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Truyện tranh</h1>
          <p className="text-sm text-muted-foreground">
            Dán một câu chuyện, chọn phong cách và nhân vật: Claude viết kịch bản, Gemini vẽ từng khung. Ảnh hôm nay {used}/{limit > 0 ? limit : "∞"}.
          </p>
        </div>
        {writer ? (
          <Link href="/app/comics/new" className={buttonVariants()}>
            <Plus aria-hidden /> Tạo truyện mới
          </Link>
        ) : null}
      </div>

      {rows.length ? (
        <Card className="py-0">
          <CardContent className="px-0">
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={`/app/comics/${r.id}`} className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted/60">
                    <BookOpen className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{r.title ?? "Truyện chưa có tên"}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.style ?? "—"} · {r.ownerName ?? "—"} · {timeAgo(r.createdAt)} · {formatUsd(Number(r.costUsd))}
                      </p>
                    </div>
                    <Badge variant={r.busyStep ? "default" : "secondary"}>{r.busyStep ? "Đang chạy…" : (COMIC_STATE_LABEL[r.state] ?? r.state)}</Badge>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Chưa có truyện nào. {writer ? "Bấm «Tạo truyện mới» để bắt đầu." : ""}</CardContent>
        </Card>
      )}
    </div>
  );
}
