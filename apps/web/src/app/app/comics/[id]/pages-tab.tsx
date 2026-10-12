import type { ComicDoc } from "@ai-news/video/comic";
import { ComicPageView } from "@ai-news/video/comic-view";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { panelsToDraw } from "@/lib/comic/doc";
import { drawPanels } from "../actions";
import { PageEditor } from "./page-editor";

type Families = Partial<Record<ComicDoc["font"], string>>;

/**
 * "Trang" (docs/COMIC.md §2.5–6): the page editor, plus drawing what is still missing. Panels not drawn yet show
 * their description; balloons are placed automatically around the faces until moved by hand.
 */
export function PagesTab({
  comicId,
  versionId,
  doc,
  srcs,
  families,
  writer,
  busy,
  approved,
}: {
  comicId: string;
  versionId: string;
  doc: ComicDoc;
  srcs: Record<string, string>;
  families: Families;
  writer: boolean;
  busy: boolean;
  approved: boolean;
}) {
  const missing = panelsToDraw(doc).length;
  return (
    <div className="space-y-4">
      {writer && approved && missing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
          <p className="text-sm">{missing} khung chưa có hình.</p>
          <ActionForm action={drawPanels}>
            <input type="hidden" name="comicId" value={comicId} />
            <Button type="submit" disabled={busy}>
              Vẽ {missing} khung còn thiếu
            </Button>
          </ActionForm>
        </div>
      ) : null}
      {!approved ? <p className="text-sm text-muted-foreground">Bản xem trước bố cục: duyệt kịch bản ở tab Kịch bản để bắt đầu vẽ.</p> : null}
      <PageEditor comicId={comicId} versionId={versionId} doc={doc} srcs={srcs} families={families} writer={writer} busy={busy} approved={approved} />
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
