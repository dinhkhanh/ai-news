import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/time";
import { deleteComic, exportPng } from "../actions";

type ExportRow = { id: string; kind: string; status: string; error: string | null; createdAt: Date; urls: string[] };

const STATUS = { queued: "Đang chờ", rendering: "Đang xuất", done: "Xong", failed: "Lỗi" } as Record<string, string>;

/** "Xuất" (docs/COMIC.md §2.7, M1 = PNG per page; PDF, webtoon strip and zip come in M3). */
export function ExportTab({ comicId, writer, busy, drawn, panels, exports }: { comicId: string; writer: boolean; busy: boolean; drawn: number; panels: number; exports: ExportRow[] }) {
  return (
    <div className="max-w-3xl space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Xuất PNG từng trang</CardTitle>
          <CardDescription>
            Mỗi trang được dựng đúng như ở tab Đọc, ở độ phân giải của khổ trang. {drawn < panels ? `Còn ${panels - drawn} khung chưa vẽ: chúng sẽ để trống.` : "Mọi khung đã có hình."}
          </CardDescription>
        </CardHeader>
        {writer ? (
          <CardContent>
            <ActionForm action={exportPng}>
              <input type="hidden" name="comicId" value={comicId} />
              <Button type="submit" disabled={busy}>
                Xuất PNG
              </Button>
            </ActionForm>
          </CardContent>
        ) : null}
      </Card>

      {exports.length ? (
        <section aria-labelledby="exports-h" className="space-y-2">
          <h2 id="exports-h" className="text-sm font-medium text-muted-foreground">
            Các lần xuất
          </h2>
          <ul className="space-y-2">
            {exports.map((e) => (
              <li key={e.id} className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {e.kind.toUpperCase()} · {timeAgo(e.createdAt)}
                  </span>
                  <Badge variant={e.status === "done" ? "success" : e.status === "failed" ? "destructive" : "secondary"}>{STATUS[e.status] ?? e.status}</Badge>
                </div>
                {e.error ? <p className="text-xs text-destructive">{e.error}</p> : null}
                {e.urls.length ? (
                  <div className="flex flex-wrap gap-2">
                    {e.urls.map((u, i) => (
                      <a key={u} href={u} target="_blank" rel="noreferrer" className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                        Trang {i + 1}
                      </a>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {writer ? (
        <ActionForm action={deleteComic}>
          <input type="hidden" name="comicId" value={comicId} />
          <Button type="submit" variant="destructive" size="sm" disabled={busy}>
            Xoá truyện này
          </Button>
        </ActionForm>
      ) : null}
    </div>
  );
}
