"use client";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditor, type EditorCtx } from "../core/context";
import { Kbd, SEVERITY_DOT } from "./ui";

type Item = { id: string; group: string; title: string; hint?: string; keys?: string; dot?: string; run: () => void };

/** Lowercase without Vietnamese diacritics, so "hinh" finds "hình". */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d").toLowerCase();

const GROUP_ORDER = ["Sửa nhanh", "Cảnh", "Cả video", "Đi tới", "Tệp"];

function items(ctx: EditorCtx): Item[] {
  const out: Item[] = [];
  // Fixes of open issues, straight from the check plugins.
  for (const i of ctx.derived.issues)
    if (i.fix) out.push({ id: `fix:${i.id}`, group: "Sửa nhanh", title: `${i.fix.label} · ${i.title}`, hint: "kiểm tra", dot: SEVERITY_DOT[i.severity], run: () => ctx.applyFix(i) });
  for (const c of ctx.plugins.contributions.commands)
    if (!c.when || c.when(ctx)) out.push({ id: c.id, group: c.group, title: c.title(ctx), keys: c.keys, hint: ctx.plugins.active.find((p) => p.commands?.includes(c))?.name, run: () => c.run(ctx) });
  ctx.plugins.contributions.panels.forEach((p, n) => {
    if (!p.when || p.when(ctx)) out.push({ id: `panel:${p.id}`, group: "Đi tới", title: `Mở bảng ${p.title}`, keys: n < 9 ? String(n + 1) : undefined, run: () => ctx.ui.setPanel(p.id) });
  });
  for (const s of ctx.doc.scenes)
    out.push({ id: `scene:${s.id}`, group: "Đi tới", title: `Cảnh ${s.id} · ${s.onScreenText || s.voiceover.slice(0, 40)}`, run: () => (ctx.select({ sceneId: s.id }), ctx.player.seekScene(s.id)) });
  return out;
}

/** ⌘K: every command, fix and destination contributed by the plugins, searchable. */
export function CommandPalette() {
  const { ui } = useEditor();
  // Mounted only while open, so every opening starts with an empty query.
  return ui.paletteOpen ? <PaletteDialog /> : null;
}

function PaletteDialog() {
  const ctx = useEditor();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const all = useMemo(() => items(ctx), [ctx]);
  const shown = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    const hits = all.filter((it) => words.every((w) => fold(`${it.title} ${it.hint ?? ""}`).includes(w)));
    return hits.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)).slice(0, 60);
  }, [all, q]);

  const close = () => ctx.ui.setPaletteOpen(false);
  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[cursor]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-3 pt-[10vh]" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Bảng lệnh" className="w-full max-w-xl overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <label className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <span className="sr-only">Tìm lệnh</span>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKey}
            autoFocus
            placeholder="Tìm lệnh, cảnh, cách sửa…"
            className="h-12 flex-1 bg-transparent text-base outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[cursor] ? `pal-${shown[cursor].id}` : undefined}
          />
          {ctx.selectedScene ? <span className="text-xs text-muted-foreground">cảnh {ctx.selectedScene.id}</span> : null}
        </label>
        <ul id="palette-list" role="listbox" aria-label="Kết quả" className="max-h-[60vh] overflow-y-auto p-1.5">
          {shown.length === 0 ? <li className="p-4 text-center text-sm text-muted-foreground">Không có lệnh nào khớp.</li> : null}
          {shown.map((it, i) => {
            const head = i === 0 || shown[i - 1].group !== it.group ? it.group : null;
            return (
              <li key={it.id} role="presentation">
                {head ? <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{head}</div> : null}
                <button
                  id={`pal-${it.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => run(it)}
                  className={cn("flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm", i === cursor && "bg-muted")}
                >
                  {it.dot ? <span className={cn("size-2 shrink-0 rounded-full", it.dot)} /> : null}
                  <span className="min-w-0 flex-1 truncate">{it.title}</span>
                  {it.hint ? <span className="shrink-0 text-[11px] text-muted-foreground">{it.hint}</span> : null}
                  {it.keys ? <Kbd>{it.keys}</Kbd> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>
            <Kbd>↑↓</Kbd> chọn
          </span>
          <span>
            <Kbd>↵</Kbd> chạy
          </span>
          <span>
            <Kbd>esc</Kbd> đóng
          </span>
          <span className="ml-auto hidden sm:inline">Lệnh, cách sửa và bảng đều do tiện ích đóng góp</span>
        </div>
      </div>
    </div>
  );
}
