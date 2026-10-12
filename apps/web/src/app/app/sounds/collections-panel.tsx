"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, ListMusic, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COLLECTION_NAME_MAX, formatDuration, SOUND_KIND_LABEL, type CollectionView } from "@/lib/media/sound-library";
import { cn } from "@/lib/utils";
import { deleteCollection, removeSound, updateCollection } from "./actions";
import { ImportForm } from "./import-form";
import { LicenceBadge, PlayButton, type Player } from "./player";

export const collectionMeta = (c: CollectionView) => `${c.items.length} âm thanh · ${formatDuration(c.items.reduce((a, i) => a + (i.durationSec ?? 0), 0))}`;

export function CollectionSwatch({ colour, size = "md" }: { colour: string; size?: "sm" | "md" }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center text-white", size === "sm" ? "size-7 rounded-md" : "size-10 rounded-[9px]")} style={{ background: colour }} aria-hidden>
      <ListMusic className={size === "sm" ? "size-3.5" : "size-[18px]"} />
    </span>
  );
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Trình duyệt không cho sao chép");
  }
}

export function CollectionsPanel({
  collections,
  urls,
  player,
  canWrite,
  openId,
  onOpen,
  onCreate,
  onBrowse,
}: {
  collections: CollectionView[];
  urls: Record<string, string>;
  player: Player;
  canWrite: boolean;
  openId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onBrowse: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [renaming, setRenaming] = useState<string | null>(null);
  const open = collections.find((c) => c.id === openId) ?? collections[0] ?? null;

  const act = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.message) (r.ok ? toast.success : toast.error)(r.message);
      if (r.ok) router.refresh();
    });

  if (!collections.length)
    return (
      <div className="rounded-xl border bg-card px-5 py-10 text-center">
        <p className="font-medium">Chưa có bộ sưu tập nào</p>
        <p className="mt-1 text-sm text-muted-foreground">Gom nhạc nền và hiệu ứng hay dùng vào một chỗ; trình chỉnh sửa video liệt kê chúng trong «Nhạc nền».</p>
        {canWrite ? (
          <Button className="mt-4" onClick={onCreate}>
            <Plus aria-hidden /> Bộ sưu tập mới
          </Button>
        ) : null}
      </div>
    );

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label="Bộ sưu tập" className="flex flex-col gap-1.5">
        {collections.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-current={c.id === open?.id ? "true" : undefined}
            onClick={() => onOpen(c.id)}
            className={cn("flex min-h-16 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted/60", c.id === open?.id && "bg-card shadow-xs ring-1 ring-border hover:bg-card")}
          >
            <CollectionSwatch colour={c.colour} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium">{c.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {collectionMeta(c)} · {c.shared ? "chia sẻ với workspace" : "chỉ mình tôi"}
              </span>
            </span>
          </button>
        ))}
        {canWrite ? (
          <Button variant="outline" className="h-11 border-dashed" onClick={onCreate}>
            <Plus aria-hidden /> Bộ sưu tập mới
          </Button>
        ) : null}
      </nav>

      {open ? (
        <section aria-labelledby="open-collection" className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b p-4 sm:p-5">
            <div className="min-w-0 flex-[1_1_16rem] space-y-1">
              {renaming === open.id ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = String(new FormData(e.currentTarget).get("name") ?? "");
                    act(async () => {
                      const r = await updateCollection({ id: open.id, name });
                      if (r.ok) setRenaming(null);
                      return r;
                    });
                  }}
                >
                  <label htmlFor="rename-collection" className="sr-only">
                    Tên bộ sưu tập
                  </label>
                  <Input id="rename-collection" name="name" defaultValue={open.name} maxLength={COLLECTION_NAME_MAX} autoFocus className="max-w-72" />
                  <Button type="submit" size="sm" disabled={pending}>
                    Lưu
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Huỷ đổi tên" onClick={() => setRenaming(null)}>
                    <X aria-hidden />
                  </Button>
                </form>
              ) : (
                <h2 id="open-collection" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                  {open.name}
                  {open.canManage ? (
                    <Button size="icon-xs" variant="ghost" aria-label="Đổi tên bộ sưu tập" onClick={() => setRenaming(open.id)}>
                      <Pencil aria-hidden />
                    </Button>
                  ) : null}
                </h2>
              )}
              <p className="text-sm text-muted-foreground">
                {collectionMeta(open)} · tạo bởi {open.mine ? "bạn" : (open.createdByName ?? "một thành viên")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {open.canManage ? (
                <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg bg-muted px-2.5 text-sm">
                  <input type="checkbox" className="size-4 accent-primary" checked={open.shared} disabled={pending} onChange={(e) => act(() => updateCollection({ id: open.id, shared: e.target.checked }))} />
                  Chia sẻ với workspace
                </label>
              ) : null}
              {open.items.length ? (
                <Button size="sm" variant="outline" onClick={() => void copyText(open.items.map((i) => i.credit).join("\n"), "Đã sao chép ghi công của cả bộ sưu tập")}>
                  <Copy aria-hidden /> Sao chép ghi công
                </Button>
              ) : null}
              {open.canEdit ? (
                <Button size="sm" onClick={onBrowse}>
                  Thêm từ thư viện
                </Button>
              ) : null}
              {open.canManage ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Xoá bộ sưu tập ${open.name}`}
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`Xoá «${open.name}»? Video đã lưu vẫn giữ âm thanh đã dùng.`)) act(() => deleteCollection({ id: open.id }));
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>

          {open.items.length ? (
            <ol className="divide-y">
              {open.items.map((it, n) => {
                const id = `item:${it.id}`;
                const url = urls[it.key];
                return (
                  <li key={it.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                    <span aria-hidden className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                      {n + 1}
                    </span>
                    <PlayButton
                      active={player.track?.id === id}
                      playing={player.isPlaying(id)}
                      label={it.title}
                      onClick={() => (url ? player.toggle({ id, url, title: it.title, subtitle: [it.creator, it.sourceLabel].filter(Boolean).join(" · "), durationSec: it.durationSec }) : toast.error("Tải lại trang để nghe âm thanh vừa thêm"))}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">{it.title}</span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {SOUND_KIND_LABEL[it.kind]} · {it.sourceLabel}
                        </span>
                        {it.creator ? <span className="max-w-40 truncate">· {it.creator}</span> : null}
                        <LicenceBadge licence={it.licence} version={it.licenceVersion} />
                        {it.landingUrl ? (
                          <a href={it.landingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                            trang gốc <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : null}
                      </span>
                    </span>
                    <span className="hidden w-11 shrink-0 text-right text-sm text-muted-foreground tabular-nums sm:block">{formatDuration(it.durationSec)}</span>
                    {open.canEdit ? (
                      <Button size="icon-sm" variant="ghost" aria-label={`Bỏ ${it.title} khỏi bộ sưu tập`} disabled={pending} onClick={() => act(() => removeSound({ itemId: it.id }))}>
                        <X aria-hidden />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="px-5 py-10 text-center">
              <p className="font-medium">Bộ sưu tập còn trống</p>
              <p className="mt-1 text-sm text-muted-foreground">Thêm âm thanh từ thư viện công cộng, nhập nhạc Pixabay, hoặc tải lên tệp có quyền dùng của bạn.</p>
            </div>
          )}

          {open.canEdit ? (
            <details className="border-t px-4 py-3 sm:px-5">
              <summary className="cursor-pointer py-1 text-sm font-medium">Tải lên tệp của bạn</summary>
              <div className="pt-3">
                <ImportForm mode="upload" collectionId={open.id} collectionName={open.name} idPrefix="own" />
              </div>
            </details>
          ) : null}
          <p className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">Trong trình chỉnh sửa, «Diện mạo» → «Nhạc nền» liệt kê các bộ sưu tập bạn thấy được. Dòng ghi công của nhạc được gắn vào video.</p>
        </section>
      ) : null}
    </div>
  );
}
