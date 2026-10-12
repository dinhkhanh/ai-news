import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { docStats, panelsToDraw } from "@/lib/comic/doc";
import { presignDoc } from "@/lib/comic/flow";
import { pageFormat } from "@/lib/comic/layout";
import { estimateDrawUsd, formatUsd, imageModel, textModel } from "@/lib/comic/models";
import { loadComic, sheetsFor, styleOf } from "@/lib/comic/service";
import { busyIsStale } from "@/lib/project-state";
import { presignGet } from "@/lib/r2";
import { canWrite } from "@/lib/workspace";
import { unstickComic } from "../actions";
import { comicFamilies } from "../fonts";
import { requireComicsWorkspace } from "../guard";
import { COMIC_STATE_LABEL, COMIC_STEP_LABEL } from "../labels";
import { CastTab } from "./cast-tab";
import { ExportTab } from "./export-tab";
import { PagesTab, ReadTab } from "./pages-tab";
import { ScriptTab } from "./script-tab";

export const dynamic = "force-dynamic";

const TABS = [
  { id: "script", label: "Kịch bản" },
  { id: "cast", label: "Nhân vật" },
  { id: "pages", label: "Trang" },
  { id: "read", label: "Đọc" },
  { id: "export", label: "Xuất" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const defaultTab = (state: string): Tab => (state === "drawn" || state === "exported" ? "read" : state === "script_approved" || state === "drawing" ? "pages" : "script");

/** One comic (docs/COMIC.md §10): tabs that follow its state, the running step, and every action of M1. */
export default async function ComicPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ws = await requireComicsWorkspace();
  const { id } = await params;
  const sp = await searchParams;
  const loaded = await loadComic(ws, id);
  if (!loaded) notFound();
  const { comic, version } = loaded;
  const doc = version?.doc ?? null;
  const writer = canWrite(ws);
  const tab: Tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as Tab) : defaultTab(comic.state);
  const stale = busyIsStale(comic);
  const running = Boolean(comic.busyStep) && !stale;
  const progress = comic.busyProgress as { label?: string; pct?: number | null } | null;
  const style = styleOf(comic);
  const stats = doc ? docStats(doc) : null;

  // Sheets of the cast in this comic's style (Nhân vật tab, and the estimate before drawing).
  const linked = doc ? doc.cast.flatMap((c) => (c.characterId ? [c.characterId] : [])) : [];
  const sheets = await sheetsFor(ws, linked, comic.styleId);
  const sheetUrls = new Map(await Promise.all([...sheets.entries()].map(async ([cid, s]) => [cid, await presignGet(s.key)] as const)));
  const missingSheets = doc ? doc.cast.filter((c) => !c.characterId || !sheets.has(c.characterId)).length : 0;
  const toDraw = doc ? panelsToDraw(doc).length : 0;
  const estimate = { panels: toDraw, sheets: missingSheets, usd: estimateDrawUsd(comic.imageModel, toDraw + missingSheets) };

  const srcs = doc && (tab === "pages" || tab === "read") ? await presignDoc(doc, { variants: tab === "pages" }) : {};
  const exports =
    tab === "export"
      ? await withOrgContext(ws, (tx) => tx.select().from(schema.comicExports).where(eq(schema.comicExports.comicId, comic.id)).orderBy(desc(schema.comicExports.createdAt)).limit(10))
      : [];
  const exportLinks = await Promise.all(exports.map(async (e) => ({ ...e, urls: e.status === "done" ? await Promise.all(e.keys.map((k) => presignGet(k))) : [] })));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <AutoRefresh active={running} everyMs={4000} />
      <div className="space-y-1">
        <Link href="/app/comics" className="text-sm text-muted-foreground hover:text-foreground">
          ← Truyện tranh
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{comic.title ?? doc?.title ?? "Truyện chưa có tên"}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={comic.state === "drawn" || comic.state === "exported" ? "success" : "secondary"}>{COMIC_STATE_LABEL[comic.state] ?? comic.state}</Badge>
            <span>
              {style.name} · {pageFormat(comic.format).label} · {textModel(comic.textModel).label} · {imageModel(comic.imageModel).label} · đã dùng {formatUsd(Number(comic.costUsd))}
            </span>
          </div>
        </div>
        {doc?.logline ? <p className="text-sm text-muted-foreground">{doc.logline}</p> : null}
      </div>

      {comic.busyStep ? (
        <div role="status" className="space-y-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">{COMIC_STEP_LABEL[comic.busyStep] ?? comic.busyStep}</span>
            <span className="text-muted-foreground">{stale ? "Không thấy tiến triển hơn 15 phút." : (progress?.label ?? "Đang xếp hàng…")}</span>
          </div>
          {!stale ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(3, Math.min(100, progress?.pct ?? 3))}%` }} />
            </div>
          ) : writer ? (
            <ActionForm action={unstickComic}>
              <input type="hidden" name="comicId" value={comic.id} />
              <Button type="submit" variant="outline" size="sm">
                Dừng bước này
              </Button>
            </ActionForm>
          ) : null}
        </div>
      ) : null}

      {comic.lastError && !comic.busyStep ? (
        <Alert variant="destructive">
          <AlertTitle>Bước vừa rồi có lỗi</AlertTitle>
          <AlertDescription>{comic.lastError}</AlertDescription>
        </Alert>
      ) : null}

      <nav aria-label="Các phần của truyện" className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/app/comics/${comic.id}?tab=${t.id}`}
            aria-current={t.id === tab ? "page" : undefined}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            {t.label}
            {t.id === "pages" && stats ? ` · ${stats.drawn}/${stats.panels}` : ""}
          </Link>
        ))}
      </nav>

      {!doc ? (
        <p className="text-sm text-muted-foreground">{comic.busyStep ? "Claude đang đọc câu chuyện và viết kịch bản; trang sẽ tự cập nhật." : "Chưa có kịch bản."}</p>
      ) : tab === "script" ? (
        <ScriptTab comic={comic} doc={doc} writer={writer} busy={running} estimate={estimate} />
      ) : tab === "cast" ? (
        <CastTab
          comicId={comic.id}
          styleId={comic.styleId}
          doc={doc}
          writer={writer}
          busy={running}
          approved={comic.state !== "created" && comic.state !== "adapted"}
          sheets={doc.cast.map((c) => {
            const s = c.characterId ? sheets.get(c.characterId) : undefined;
            return { ref: c.ref, sheet: s && c.characterId ? { id: s.id, status: s.status, url: sheetUrls.get(c.characterId)! } : null };
          })}
        />
      ) : tab === "pages" ? (
        <PagesTab comicId={comic.id} versionId={version!.id} doc={doc} srcs={srcs} families={comicFamilies} writer={writer} busy={running} approved={comic.state !== "created" && comic.state !== "adapted"} />
      ) : tab === "read" ? (
        <ReadTab doc={doc} srcs={srcs} families={comicFamilies} />
      ) : (
        <ExportTab comicId={comic.id} writer={writer} busy={running} drawn={stats ? stats.drawn : 0} panels={stats ? stats.panels : 0} exports={exportLinks.map((e) => ({ id: e.id, kind: e.kind, status: e.status, error: e.error, createdAt: e.createdAt, files: e.urls.map((url, i) => ({ url, name: e.keys[i].split("/").slice(-2).join("/").replace(/^[0-9a-f-]{36}\//, "") })) }))} />
      )}
    </div>
  );
}
