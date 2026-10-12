"use client";
import { useState } from "react";
import { Check, ExternalLink, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  formatDuration,
  OPENVERSE_MAX_RESULTS,
  OPENVERSE_SOURCES,
  pixabaySearchUrl,
  SOUND_KIND_LABEL,
  SOUND_LENGTHS,
  SOUND_PAGE_SIZE,
  type OpenverseSource,
  type SoundLength,
  type SoundResult,
} from "@/lib/media/sound-library";
import { cn } from "@/lib/utils";
import { searchSounds } from "./actions";
import { ImportForm } from "./import-form";
import { LicenceBadge, PlayButton, type Player } from "./player";

type Kind = "all" | "music" | "sfx";
type Filters = { q: string; kind: Kind; sources: OpenverseSource[]; commercialOnly: boolean; lengths: SoundLength[] };

/** Suggested first searches: Openverse indexes mostly English titles and tags. */
const SUGGESTIONS = [
  { q: "news", label: "nhạc nền tin tức", kind: "music" as Kind },
  { q: "rain", label: "mưa", kind: "sfx" as Kind },
  { q: "whoosh", label: "whoosh chuyển cảnh", kind: "sfx" as Kind },
  { q: "typing", label: "gõ bàn phím", kind: "sfx" as Kind },
  { q: "crowd", label: "đám đông", kind: "sfx" as Kind },
  { q: "piano calm", label: "piano nhẹ", kind: "music" as Kind },
];

const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "music", label: "Nhạc nền" },
  { id: "sfx", label: "Hiệu ứng" },
];

export type BrowseProps = {
  player: Player;
  canWrite: boolean;
  target: { id: string; name: string; providerIds: Set<string> } | null;
  onFocus: (r: SoundResult) => void;
  onAdd: (ids: string[]) => Promise<boolean>;
  adding: Set<string>;
  aside: React.ReactNode;
};

export function BrowsePanel({ player, canWrite, target, onFocus, onAdd, adding, aside }: BrowseProps) {
  const [f, setF] = useState<Filters>({ q: "", kind: "all", sources: OPENVERSE_SOURCES.map((s) => s.id), commercialOnly: true, lengths: [] });
  const [draft, setDraft] = useState("");
  const [results, setResults] = useState<SoundResult[]>([]);
  const [meta, setMeta] = useState<{ total: number; page: number; pageCount: number; hidden: number } | null>(null);
  const [loading, setLoading] = useState<"new" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function run(next: Filters, page = 1, force = false) {
    setF(next);
    if (!force && !next.q && !meta) return; // filters alone do not search until a first search ran
    setLoading(page === 1 ? "new" : "more");
    setError(null);
    const r = await searchSounds({ ...next, page });
    setLoading(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setResults((prev) => (page === 1 ? r.results : [...prev, ...r.results.filter((x) => !prev.some((p) => p.providerId === x.providerId))]));
    setMeta({ total: r.total, page: r.page, pageCount: r.pageCount, hidden: r.hidden });
    if (page === 1) setSelected(new Set());
  }

  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const selectedIds = [...selected];

  return (
    <div className="space-y-4">
      <form
        role="search"
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run({ ...f, q: draft.trim() }, 1, true);
        }}
      >
        <div className="flex flex-wrap gap-2">
          <label htmlFor="sound-q" className="sr-only">
            Tìm âm thanh
          </label>
          <div className="relative min-w-0 flex-[1_1_20rem]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="sound-q" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={200} placeholder="rain, keyboard typing, news intro… (tiếng Anh cho nhiều kết quả hơn)" className="h-11 pl-9" />
          </div>
          <Button type="submit" className="h-11 px-5" disabled={loading !== null}>
            {loading === "new" ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Tìm
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Tìm trong{" "}
          <a href="https://openverse.org/" target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Openverse
          </a>{" "}
          (Jamendo, Freesound, Wikimedia Commons). Nhạc Pixabay nhập bằng tệp, ở cuối trang. Chỉ âm thanh có giấy phép mở; dòng ghi công được tạo sẵn.
        </p>
      </form>

      <div className="grid items-start gap-5 lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
        <aside aria-label="Bộ lọc" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
          <fieldset className="space-y-1">
            <legend className="pb-1.5 text-sm font-medium">Loại</legend>
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                aria-pressed={f.kind === k.id}
                onClick={() => void run({ ...f, kind: k.id })}
                className={cn("flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted", f.kind === k.id && "bg-muted font-medium text-foreground")}
              >
                {k.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="space-y-0.5">
            <legend className="pb-1.5 text-sm font-medium">Nguồn</legend>
            {OPENVERSE_SOURCES.map((s) => (
              <label key={s.id} className="flex min-h-9 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={f.sources.includes(s.id)}
                  onChange={() => {
                    const sources = toggleIn(f.sources, s.id);
                    if (sources.length) void run({ ...f, sources });
                  }}
                />
                <span className="flex-1">{s.label}</span>
                <span className="text-xs text-muted-foreground">{s.hint}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="pb-1.5 text-sm font-medium">Giấy phép</legend>
            <label className="flex cursor-pointer items-start gap-2.5 py-1 text-sm">
              <input type="radio" name="sound-licence" className="mt-0.5 size-4 accent-primary" checked={f.commercialOnly} onChange={() => void run({ ...f, commercialOnly: true })} />
              <span>
                Dùng cho kênh kiếm tiền
                <span className="block text-xs text-muted-foreground">CC0, CC BY, CC BY-SA</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 py-1 text-sm">
              <input type="radio" name="sound-licence" className="mt-0.5 size-4 accent-primary" checked={!f.commercialOnly} onChange={() => void run({ ...f, commercialOnly: false })} />
              <span>
                Mọi giấy phép Creative Commons
                <span className="block text-xs text-muted-foreground">gồm cả NC: không dùng thương mại</span>
              </span>
            </label>
          </fieldset>
          <fieldset>
            <legend className="pb-1.5 text-sm font-medium">Thời lượng</legend>
            <div className="flex flex-wrap gap-1.5">
              {SOUND_LENGTHS.map((l) => {
                const on = f.lengths.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => void run({ ...f, lengths: toggleIn(f.lengths, l.id) })}
                    className={cn("h-8 rounded-full border px-2.5 text-xs transition-colors hover:bg-muted", on ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground")}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </aside>

        <section aria-labelledby="sound-results" className="min-w-0 space-y-2">
          <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 px-1">
            <h2 id="sound-results" className="text-sm font-medium text-muted-foreground">
              {meta ? `${meta.total >= OPENVERSE_MAX_RESULTS ? `${OPENVERSE_MAX_RESULTS}+` : meta.total} kết quả${f.q ? ` cho «${f.q}»` : ""}${meta.hidden ? ` · ẩn ${meta.hidden} không dùng thương mại được` : ""}` : "Kết quả"}
            </h2>
            {selectedIds.length && canWrite ? (
              <div className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary/10 py-0.5 pr-0.5 pl-3 ring-1 ring-primary/30">
                <span className="text-sm text-primary">{selectedIds.length} đã chọn</span>
                <Button
                  size="sm"
                  disabled={!target || selectedIds.some((id) => adding.has(id))}
                  onClick={async () => {
                    if (selectedIds.length > 10) toast.message("Thêm 10 âm thanh đầu; chọn tiếp sau đó");
                    if (await onAdd(selectedIds.slice(0, 10))) setSelected(new Set());
                  }}
                >
                  {target ? `Thêm vào «${target.name}»` : "Chọn bộ sưu tập"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Bỏ chọn
                </Button>
              </div>
            ) : null}
          </div>

          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

          {!meta && !loading ? (
            <div className="rounded-xl border bg-card px-5 py-8 text-center">
              <p className="font-medium">Bắt đầu bằng một từ khoá</p>
              <p className="mt-1 text-sm text-muted-foreground">Hoặc thử:</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button
                    key={s.q}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraft(s.q);
                      void run({ ...f, q: s.q, kind: s.kind });
                    }}
                  >
                    {s.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {meta && results.length === 0 && !loading ? (
            <div className="rounded-xl border bg-card px-5 py-8 text-center">
              <p className="font-medium">Không có âm thanh nào khớp</p>
              <p className="mt-1 text-sm text-muted-foreground">Thử từ khoá tiếng Anh (rain, keyboard, whoosh) hoặc nới bộ lọc giấy phép, thời lượng.</p>
            </div>
          ) : null}

          {results.length ? (
            <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card", loading === "new" && "opacity-60")}>
              {results.map((r) => {
                const id = `ov:${r.providerId}`;
                const inTarget = target?.providerIds.has(r.providerId) ?? false;
                const isAdding = adding.has(r.providerId);
                const sel = selected.has(r.providerId);
                const active = player.track?.id === id;
                return (
                  <li key={r.providerId} className={cn("flex items-center gap-3 px-3 py-2.5 sm:px-4", sel && "bg-primary/5")}>
                    {canWrite ? (
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        checked={sel}
                        onChange={() => setSelected((prev) => (prev.has(r.providerId) ? new Set([...prev].filter((x) => x !== r.providerId)) : new Set([...prev, r.providerId])))}
                        aria-label={`Chọn ${r.title}`}
                      />
                    ) : null}
                    <PlayButton
                      active={active}
                      playing={player.isPlaying(id)}
                      label={r.title}
                      onClick={() => {
                        onFocus(r);
                        player.toggle({ id, url: r.audioUrl, title: r.title, subtitle: [r.creator, r.sourceLabel].filter(Boolean).join(" · "), durationSec: r.durationSec });
                      }}
                    />
                    <button type="button" onClick={() => onFocus(r)} className="flex min-w-0 flex-1 flex-col gap-1 text-left outline-none focus-visible:underline">
                      <span className="truncate font-medium">{r.title}</span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>{SOUND_KIND_LABEL[r.kind]}</span>
                        <span>· {r.sourceLabel}</span>
                        {r.creator ? <span className="max-w-40 truncate">· {r.creator}</span> : null}
                        <LicenceBadge licence={r.licence} version={r.licenceVersion} />
                      </span>
                    </button>
                    <span className="hidden w-11 shrink-0 text-right text-sm text-muted-foreground tabular-nums sm:block">{formatDuration(r.durationSec)}</span>
                    {canWrite ? (
                      <Button
                        size="sm"
                        variant={inTarget ? "secondary" : "outline"}
                        className={cn("min-w-24", inTarget && "text-success")}
                        disabled={!target || inTarget || isAdding}
                        aria-label={inTarget ? `${r.title} đã có trong ${target?.name}` : `Thêm ${r.title} vào ${target?.name ?? "bộ sưu tập"}`}
                        onClick={() => void onAdd([r.providerId])}
                      >
                        {isAdding ? <Loader2 className="animate-spin" aria-hidden /> : inTarget ? <Check aria-hidden /> : <Plus aria-hidden />}
                        {inTarget ? "Đã thêm" : "Thêm"}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {meta && meta.page < Math.min(meta.pageCount, OPENVERSE_MAX_RESULTS / SOUND_PAGE_SIZE) && results.length ? (
            <div className="flex justify-center pt-1">
              <Button variant="outline" disabled={loading !== null} onClick={() => void run(f, meta.page + 1)}>
                {loading === "more" ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Tải thêm kết quả
              </Button>
            </div>
          ) : null}

          <section aria-labelledby="pixabay-import" className="mt-4 space-y-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="min-w-0 flex-[1_1_20rem] space-y-1">
                <h2 id="pixabay-import" className="text-sm font-semibold">
                  Nhạc từ Pixabay
                </h2>
                <p className="text-sm text-muted-foreground">Pixabay không mở API cho nhạc. Tìm bài trên Pixabay, tải MP3 về rồi nhập vào bộ sưu tập; giấy phép Pixabay được điền sẵn, ghi công không bắt buộc.</p>
              </div>
              <Button variant="outline" size="sm" render={<a href={pixabaySearchUrl(f.q || draft)} target="_blank" rel="noreferrer" />}>
                Tìm «{(f.q || draft).trim() || "nhạc"}» trên Pixabay
                <ExternalLink aria-hidden />
              </Button>
            </div>
            {canWrite ? <ImportForm mode="pixabay" collectionId={target?.id ?? null} collectionName={target?.name ?? null} idPrefix="pixabay" /> : null}
          </section>
        </section>

        {aside}
      </div>
    </div>
  );
}
