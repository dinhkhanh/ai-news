import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/time";
import { deleteComic, exportComic } from "../actions";

type ExportRow = { id: string; kind: string; status: string; error: string | null; createdAt: Date; files: { url: string; name: string }[] };

const KINDS = [
  { id: "png", label: "PNG từng trang", note: "đúng như tab Đọc, ở độ phân giải của khổ trang" },
  { id: "pdf", label: "PDF", note: "mỗi trang một trang PDF, đúng khổ in" },
  { id: "webtoon", label: "Webtoon", note: "một cột rộng 800 px, chia tệp ≤ 8 000 px, cắt giữa các khung" },
  { id: "zip", label: "Tất cả (zip)", note: "PNG + PDF + webtoon trong một tệp" },
] as const;
const KIND_LABEL: Record<string, string> = { png: "PNG", pdf: "PDF", webtoon: "Webtoon", zip: "Zip" };

const STATUS = { queued: "Đang chờ", rendering: "Đang xuất", done: "Xong", failed: "Lỗi" } as Record<string, string>;

/** "Xuất" (docs/COMIC.md §2.7): PNG per page, PDF, webtoon strip, zip of everything. */
export function ExportTab({ comicId, writer, busy, drawn, panels, exports }: { comicId: string; writer: boolean; busy: boolean; drawn: number; panels: number; exports: ExportRow[] }) {
  return (
    <div className="max-w-3xl space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Xuất truyện</CardTitle>
          <CardDescription>
            Mọi tệp được dựng bằng đúng thành phần của tab Đọc. {drawn < panels ? `Còn ${panels - drawn} khung chưa vẽ: chúng sẽ để trống.` : "Mọi khung đã có hình."} Xuất lại cùng một phiên bản dùng lại các trang PNG đã dựng.
          </CardDescription>
        </CardHeader>
        {writer ? (
          <CardContent>
            <ActionForm action={exportComic} className="space-y-3">
              <input type="hidden" name="comicId" value={comicId} />
              <fieldset className="space-y-2">
                <legend className="sr-only">Định dạng</legend>
                {KINDS.map((k) => (
                  <label key={k.id} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="kind" value={k.id} defaultChecked={k.id === "png" || k.id === "pdf"} className="mt-1" />
                    <span>
                      <span className="font-medium">{k.label}</span> <span className="text-muted-foreground">· {k.note}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <Button type="submit" disabled={busy}>
                Xuất
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
                    {KIND_LABEL[e.kind] ?? e.kind} · {timeAgo(e.createdAt)}
                  </span>
                  <Badge variant={e.status === "done" ? "success" : e.status === "failed" ? "destructive" : "secondary"}>{STATUS[e.status] ?? e.status}</Badge>
                </div>
                {e.error ? <p className="text-xs text-destructive">{e.error}</p> : null}
                {e.files.length ? (
                  <div className="flex flex-wrap gap-2">
                    {e.files.map((f) => (
                      <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                        {f.name}
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
