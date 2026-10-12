"use client";
import { useEffect, useState } from "react";
import type { Timeline } from "@ai-news/video/schema";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { CommandPalette } from "./command-palette";
import { Deliver } from "./deliver";
import { Inspector } from "./inspector";
import { MobileNav, Rail } from "./rail";
import { Stage } from "./stage";
import { Timeline as TimelineView } from "./timeline";
import { TopBar } from "./top-bar";

/**
 * The editor's screen: a full-window workspace above the app shell (the editor has its own header with a way back).
 * Desktop: rail · panel · preview · inspector over a full-width timeline. Phone: preview, timeline, then the chosen
 * panel or the inspector, with the rail as a bottom bar. "Xuất & duyệt" swaps the middle for the Deliver view.
 */
export function Workspace({ timeline }: { timeline: Timeline }) {
  const ctx = useEditor();
  // Phone only: which sheet sits under the timeline.
  const [sheet, setSheet] = useState<"panel" | "inspector">("inspector");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const panel = ctx.plugins.contributions.panels.find((p) => p.id === ctx.ui.panel && (!p.when || p.when(ctx))) ?? ctx.plugins.contributions.panels[0];
  const PanelComponent = panel?.Component;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <TopBar />
      {ctx.ui.mode === "deliver" ? (
        <Deliver timeline={timeline} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-16 lg:grid lg:grid-cols-[56px_300px_minmax(0,1fr)_minmax(320px,360px)] lg:grid-rows-[minmax(0,1fr)_auto] lg:overflow-hidden lg:pb-0">
          <Rail className="hidden lg:col-start-1 lg:row-start-1 lg:flex" />
          <aside aria-label={panel?.title ?? "Bảng"} className={cn("order-2 min-h-0 border-r bg-card lg:order-none lg:col-start-2 lg:row-start-1 lg:block lg:overflow-y-auto", sheet === "panel" ? "block" : "hidden")}>
            {PanelComponent ? <PanelComponent /> : null}
          </aside>
          <Stage timeline={timeline} className="order-first h-[52dvh] shrink-0 lg:order-none lg:col-start-3 lg:row-start-1 lg:h-auto" />
          <aside aria-label="Chi tiết cảnh" className={cn("order-2 min-h-0 border-l bg-card lg:order-none lg:col-start-4 lg:row-start-1 lg:flex lg:flex-col", sheet === "inspector" ? "flex flex-col" : "hidden")}>
            <Inspector />
          </aside>
          <TimelineView className="order-1 lg:order-none lg:col-span-4 lg:col-start-1 lg:row-start-2" />
        </div>
      )}
      {ctx.ui.mode === "edit" ? <MobileNav sheet={sheet} onSheet={setSheet} /> : null}
      <CommandPalette />
    </div>
  );
}
