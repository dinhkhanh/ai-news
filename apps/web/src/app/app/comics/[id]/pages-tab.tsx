import type { ComicDoc } from "@ai-news/video/comic";
import { ComicPageView } from "@ai-news/video/comic-view";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { panelsToDraw } from "@/lib/comic/doc";
import { drawPanels } from "../actions";

type Families = Partial<Record<ComicDoc["font"], string>>;

/**
 * "Trang" (docs/COMIC.md §2.5–6): every page as it will be exported (same `ComicPageView`), with a redraw form per
 * panel. Panels not drawn yet show their description; balloons are placed automatically around the faces.
 */
export function PagesTab({ comicId, doc, srcs, families, writer, busy, approved }: { comicId: string; doc: ComicDoc; srcs: Record<string, string>; families: Families; writer: boolean; busy: boolean; approved: boolean }) {
  const locked = !writer || busy;
  const missing = panelsToDraw(doc).length;
  return (
    <div className="space-y-6">
      {writer && approved && missing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
          <p className="text-sm">{missing} khung chưa có hình.</p>
          <ActionForm action={drawPanels}>
            <input type="hidden" name="comicId" value={comicId} />
            <Button type="submit" disabled={locked}>
              Vẽ {missing} khung còn thiếu
            </Button>
          </ActionForm>
        </div>
      ) : null}
      {!approved ? <p className="text-sm text-muted-foreground">Bản xem trước bố cục: duyệt kịch bản ở tab Kịch bản để bắt đầu vẽ.</p> : null}
      {doc.pages.map((page, pi) => (
        <section key={page.id} aria-label={`Trang ${pi + 1}`} className="grid items-start gap-4 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Trang {pi + 1} / {doc.pages.length}
            </p>
            <div className="overflow-hidden rounded-sm shadow-md ring-1 ring-border">
              <ComicPageView format={doc.format} font={doc.font} page={page} srcs={srcs} placeholders families={families} credit={pi === doc.pages.length - 1 ? doc.credit : null} />
            </div>
          </div>
          <ol className="space-y-2">
            {page.panels.map((k, ki) => (
              <li key={k.id} className="space-y-2 rounded-lg border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">Khung {ki + 1}</span>
                  <span className={k.image ? "text-xs text-success" : k.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                    {k.image ? `đã vẽ · ${k.variants.length} phương án` : k.error ? "lỗi khi vẽ" : "chưa vẽ"}
                  </span>
                </div>
                {k.error && !k.image ? <p className="text-xs text-destructive">{k.error}</p> : null}
                {k.lettering.some((b) => b.overflow) ? <p className="text-xs text-amber-700 dark:text-amber-400">Chữ quá dài cho khung này: rút gọn lời ở tab Kịch bản.</p> : null}
                {writer && approved ? (
                  <ActionForm action={drawPanels} className="flex items-end gap-2">
                    <input type="hidden" name="comicId" value={comicId} />
                    <input type="hidden" name="panelId" value={k.id} />
                    <Input name="instruction" placeholder="Chỉ dẫn (vd: bà đứng gần hơn)" aria-label={`Chỉ dẫn vẽ lại khung ${ki + 1}`} className="min-w-0 flex-1" disabled={locked} />
                    <Button type="submit" size="sm" variant="outline" disabled={locked}>
                      {k.image ? "Vẽ lại" : "Vẽ"}
                    </Button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** "Đọc": the pages one after another, as a reader sees them (vertical scroll, also on phones). */
export function ReadTab({ doc, srcs, families }: { doc: ComicDoc; srcs: Record<string, string>; families: Families }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {doc.pages.map((page, pi) => (
        <div key={page.id} className="overflow-hidden rounded-sm shadow-md ring-1 ring-border">
          <ComicPageView format={doc.format} font={doc.font} page={page} srcs={srcs} families={families} credit={pi === doc.pages.length - 1 ? doc.credit : null} />
        </div>
      ))}
    </div>
  );
}
