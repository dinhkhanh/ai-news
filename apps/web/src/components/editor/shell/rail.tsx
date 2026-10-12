"use client";
import { PanelLeftClose, PanelLeftOpen, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import type { PanelContribution } from "../core/plugin";

function useVisiblePanels() {
  const ctx = useEditor();
  return ctx.plugins.contributions.panels.filter((p) => !p.when || p.when(ctx));
}

function BadgeDot({ panel }: { panel: PanelContribution }) {
  const ctx = useEditor();
  const b = panel.badge?.(ctx);
  if (!b || !b.count) return null;
  return (
    <span className={cn("absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold", b.tone === "warn" ? "bg-amber-500 text-black" : "bg-primary text-primary-foreground")}>
      {b.count > 99 ? "99+" : b.count}
    </span>
  );
}

/**
 * Desktop: one icon per panel plugin, in plugin order; digits 1–9 open them. Clicking the open panel's icon
 * collapses the panel column (so does the toggle at the bottom, or ⌘B); any icon opens it again.
 */
export function Rail({ className }: { className?: string }) {
  const ctx = useEditor();
  const panels = useVisiblePanels();
  const open = ctx.ui.panelOpen;
  const Toggle = open ? PanelLeftClose : PanelLeftOpen;
  return (
    <nav aria-label="Bảng" className={cn("flex-col items-center gap-1 border-r bg-sidebar py-2", className)}>
      {panels.map((p, i) => {
        const Icon = p.icon;
        const active = open && ctx.ui.panel === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => (active ? ctx.ui.setPanelOpen(false) : ctx.ui.setPanel(p.id))}
            aria-label={p.title}
            aria-pressed={active}
            aria-controls="editor-panel"
            title={active ? `${p.title} · bấm để thu gọn (${i + 1})` : `${p.title} (${i + 1})`}
            className={cn("relative flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground", active && "bg-card text-foreground shadow-xs ring-1 ring-border")}
          >
            <Icon className="size-5" />
            <BadgeDot panel={p} />
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => ctx.ui.setPanelOpen(!open)}
        aria-expanded={open}
        aria-controls="editor-panel"
        aria-label={open ? "Thu gọn bảng (⌘B)" : "Mở bảng (⌘B)"}
        title={open ? "Thu gọn bảng (⌘B)" : "Mở bảng (⌘B)"}
        className="mt-auto flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
      >
        <Toggle className="size-5" />
      </button>
    </nav>
  );
}

/** Phone: the panels plus "Chi tiết" (the inspector), as a bottom bar. */
export function MobileNav({ sheet, onSheet }: { sheet: "panel" | "inspector"; onSheet: (s: "panel" | "inspector") => void }) {
  const ctx = useEditor();
  const panels = useVisiblePanels().slice(0, 5);
  return (
    <nav aria-label="Bảng" className="pb-safe fixed inset-x-0 bottom-0 z-10 grid border-t bg-card lg:hidden" style={{ gridTemplateColumns: `repeat(${panels.length + 1}, minmax(0, 1fr))` }}>
      <button type="button" aria-pressed={sheet === "inspector"} onClick={() => onSheet("inspector")} className={cn("flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground", sheet === "inspector" && "text-primary")}>
        <PencilLine className="size-5" />
        Chi tiết
      </button>
      {panels.map((p) => {
        const Icon = p.icon;
        const active = sheet === "panel" && ctx.ui.panel === p.id;
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={active}
            onClick={() => {
              ctx.ui.setPanel(p.id);
              onSheet("panel");
            }}
            className={cn("relative flex h-14 flex-col items-center justify-center gap-0.5 truncate px-1 text-[11px] text-muted-foreground", active && "text-primary")}
          >
            <Icon className="size-5" />
            <span className="max-w-full truncate">{p.title}</span>
            <BadgeDot panel={p} />
          </button>
        );
      })}
    </nav>
  );
}
