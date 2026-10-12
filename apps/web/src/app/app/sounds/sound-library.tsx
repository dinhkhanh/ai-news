"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COLLECTION_NAME_MAX, formatDuration, licenceInfo, SOUND_KIND_LABEL, soundCredit, type CollectionView, type SoundResult } from "@/lib/media/sound-library";
import { cn } from "@/lib/utils";
import { addSounds, createCollection } from "./actions";
import { BrowsePanel } from "./browse-panel";
import { CollectionsPanel, CollectionSwatch, collectionMeta } from "./collections-panel";
import { PlayerBar, usePlayer } from "./player";

type Props = {
  collections: CollectionView[];
  urls: Record<string, string>;
  canWrite: boolean;
  initialTab: "browse" | "collections";
  initialCollectionId: string | null;
};

/** Browse the public library and keep sounds in collections (the two tabs share one player and one target collection). */
export function SoundLibrary({ collections, urls, canWrite, initialTab, initialCollectionId }: Props) {
  const router = useRouter();
  const player = usePlayer();
  const [tab, setTab] = useState(initialTab);
  const editable = collections.filter((c) => c.canEdit);
  const [targetId, setTargetId] = useState<string | null>(initialCollectionId ?? editable[0]?.id ?? null);
  const [openId, setOpenId] = useState<string | null>(initialCollectionId ?? collections[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [focus, setFocus] = useState<SoundResult | null>(null);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const target = editable.find((c) => c.id === targetId) ?? editable[0] ?? null;
  const targetInfo = target ? { id: target.id, name: target.name, providerIds: new Set(target.items.filter((i) => i.provider === "openverse" && i.providerId).map((i) => i.providerId!)) } : null;

  async function add(ids: string[]) {
    if (!target) {
      toast.error("Tạo một bộ sưu tập trước");
      setCreating(true);
      return false;
    }
    setAdding((prev) => new Set([...prev, ...ids]));
    const r = await addSounds({ collectionId: target.id, ids });
    setAdding((prev) => new Set([...prev].filter((x) => !ids.includes(x))));
    if (!r.ok) {
      toast.error(r.message);
      return false;
    }
    toast.success(r.message, r.failed.length ? { description: r.failed.join("\n") } : undefined);
    router.refresh();
    return true;
  }

  function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const r = await createCollection({ name: String(fd.get("name") ?? ""), shared: fd.get("shared") === "on" });
      if (!r.ok) return void toast.error(r.message);
      toast.success(r.message);
      setTargetId(r.id);
      setOpenId(r.id);
      setCreating(false);
      router.refresh();
    });
  }

  const aside = (
    <aside className="space-y-4">
      <section aria-labelledby="my-collections" className="space-y-2.5 rounded-xl border bg-card p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="my-collections" className="text-sm font-semibold">
            Bộ sưu tập
          </h2>
          {editable.length ? <span className="text-xs text-muted-foreground">bấm để thêm vào</span> : null}
        </div>
        {editable.length ? (
          <ul className="space-y-1">
            {editable.map((c) => {
              const on = c.id === target?.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTargetId(c.id)}
                    className={cn("flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-muted", on && "bg-primary/10 ring-1 ring-primary/40 hover:bg-primary/10")}
                  >
                    <CollectionSwatch colour={c.colour} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {collectionMeta(c)}
                        {c.shared ? "" : " · riêng"}
                      </span>
                    </span>
                    {on ? <span className="text-xs text-primary">đang thêm vào</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{canWrite ? "Chưa có bộ sưu tập. Tạo một bộ để lưu âm thanh." : "Vai trò của bạn chỉ xem được thư viện."}</p>
        )}
        {canWrite ? (
          creating || !editable.length ? (
            <form onSubmit={create} className="space-y-2 border-t pt-3">
              <Label htmlFor="new-collection">Tên bộ sưu tập</Label>
              <Input id="new-collection" name="name" required maxLength={COLLECTION_NAME_MAX} placeholder="vd. Tin nóng, Thời tiết" autoFocus={creating} />
              <label className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="shared" defaultChecked className="size-4 accent-primary" /> chia sẻ với cả workspace
              </label>
              <div className="flex gap-2">
                <Button type="submit" size="sm" className="flex-1" disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Tạo
                </Button>
                {editable.length ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
                    Huỷ
                  </Button>
                ) : null}
              </div>
            </form>
          ) : (
            <Button variant="outline" className="w-full border-dashed" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> Bộ sưu tập mới
            </Button>
          )
        ) : null}
      </section>

      {focus ? <LicenceCard r={focus} /> : null}
    </aside>
  );

  return (
    <div className="space-y-5">
      <div role="group" aria-label="Chế độ xem" className="inline-flex h-9 items-stretch rounded-xl bg-sidebar p-0.5 pointer-coarse:h-11">
        {(
          [
            ["browse", "Khám phá"],
            ["collections", `Bộ sưu tập · ${collections.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn("rounded-[9px] px-3 text-[0.9375rem] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground", tab === id && "bg-card font-medium text-foreground shadow-xs ring-1 ring-sidebar-border")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "browse" ? (
        <BrowsePanel player={player} canWrite={canWrite} target={targetInfo} onFocus={setFocus} onAdd={add} adding={adding} aside={aside} />
      ) : (
        <CollectionsPanel
          collections={collections}
          urls={urls}
          player={player}
          canWrite={canWrite}
          openId={openId}
          onOpen={(id) => {
            setOpenId(id);
            if (editable.some((c) => c.id === id)) setTargetId(id);
          }}
          onCreate={() => {
            setCreating(true);
            setTab("browse");
          }}
          onBrowse={() => setTab("browse")}
        />
      )}

      <PlayerBar player={player} />
    </div>
  );
}

function LicenceCard({ r }: { r: SoundResult }) {
  const l = licenceInfo(r.licence, r.licenceVersion);
  const credit = soundCredit({ title: r.title, creator: r.creator, sourceLabel: r.sourceLabel, licence: r.licence, licenceVersion: r.licenceVersion }, r.kind === "music" ? "music" : "sfx");
  return (
    <section aria-labelledby="licence-card" className="space-y-2.5 rounded-xl border bg-card p-3.5">
      <h2 id="licence-card" className="text-sm font-semibold">
        Giấy phép và ghi công
      </h2>
      <div>
        <p className="font-medium">{r.title}</p>
        <p className="text-xs text-muted-foreground">
          {SOUND_KIND_LABEL[r.kind]} · {formatDuration(r.durationSec)} · {r.sourceLabel}
          {r.creator ? ` · ${r.creator}` : ""}
        </p>
      </div>
      <p className={cn("rounded-lg px-2.5 py-2 text-xs leading-relaxed", l.commercial && l.tone !== "restricted" ? "bg-muted" : "bg-amber-500/15 text-amber-900 dark:text-amber-200")}>
        <span className="font-medium">{l.label}.</span> {l.note}
      </p>
      <div className="space-y-1">
        <p id="credit-label" className="text-xs text-muted-foreground">
          Dòng ghi công, gắn vào video khi dùng làm nhạc nền
        </p>
        <p aria-labelledby="credit-label" className="rounded-lg border bg-background px-2.5 py-2 text-xs leading-relaxed">
          {credit}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() =>
            navigator.clipboard.writeText(credit).then(
              () => toast.success("Đã sao chép ghi công"),
              () => toast.error("Trình duyệt không cho sao chép"),
            )
          }
        >
          <Copy aria-hidden /> Sao chép
        </Button>
        {r.landingUrl ? (
          <Button size="sm" variant="outline" className="flex-1" render={<a href={r.landingUrl} target="_blank" rel="noreferrer" />}>
            Trang gốc <ExternalLink aria-hidden />
          </Button>
        ) : null}
      </div>
    </section>
  );
}
