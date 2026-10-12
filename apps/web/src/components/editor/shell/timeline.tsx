"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { usePlayerTime, useEditor } from "../core/context";
import type { TimelineLayout } from "../core/plugin";

const LABEL_W = 84;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60];

function Playhead({ layout }: { layout: TimelineLayout }) {
  const ctx = useEditor();
  const { frame } = usePlayerTime();
  return (
    <div aria-hidden className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-primary" style={{ left: LABEL_W + layout.x(frame / ctx.player.fps) }}>
      <span className="absolute -top-0 -left-1.5 h-2.5 w-3.5 rounded-sm bg-primary" />
    </div>
  );
}

/**
 * The timeline: a ruler with plugin markers (comments, cover), then one row per track plugin (scenes,
 * shots, captions, voice, music). Click or drag on the ruler to move the playhead; zoom stretches time.
 */
export function Timeline({ className }: { className?: string }) {
  const ctx = useEditor();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(1000);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const durationSec = Math.max(1, ctx.durationSec);
  const fitPps = Math.max(8, (boxW - LABEL_W - 12) / durationSec);
  const pxPerSec = fitPps * zoom;
  const layout = useMemo<TimelineLayout>(() => ({ pxPerSec, durationSec, width: durationSec * pxPerSec, x: (sec: number) => sec * pxPerSec }), [pxPerSec, durationSec]);
  const step = TICK_STEPS.find((s) => s * pxPerSec >= 56) ?? 60;
  const ticks = Array.from({ length: Math.floor(durationSec / step) + 1 }, (_, i) => i * step);
  const tracks = ctx.plugins.contributions.tracks.filter((t) => !t.when || t.when(ctx));
  const markers = ctx.plugins.contributions.markers.flatMap((m) => m.items(ctx));

  const seekFrom = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    ctx.player.seek(Math.min(durationSec, Math.max(0, (e.clientX - rect.left) / pxPerSec)));
  };

  return (
    <section aria-label="Dòng thời gian" className={cn("flex min-w-0 flex-col border-t bg-card", className)}>
      <div className="flex flex-wrap items-center gap-3 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Dòng thời gian</span>
        <span className="hidden sm:inline">bấm thước để tua · kéo hình từ Thư viện thả vào hàng Hình</span>
        <label className="ml-auto flex items-center gap-2">
          Thu phóng
          <input type="range" min={1} max={6} step={0.5} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24 accent-primary" aria-label="Thu phóng dòng thời gian" />
        </label>
        <button type="button" className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => setZoom(1)}>
          vừa khung
        </button>
      </div>
      <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
        <div className="relative pb-2" style={{ width: LABEL_W + layout.width + 12 }}>
          {/* ruler */}
          <div className="flex h-7">
            <div className="sticky left-0 z-10 shrink-0 bg-card" style={{ width: LABEL_W }} />
            <div className="relative h-full cursor-pointer touch-none select-none" style={{ width: layout.width }} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekFrom(e); }} onPointerMove={(e) => e.buttons === 1 && seekFrom(e)}>
              {ticks.map((t) => (
                <span key={t} className="absolute bottom-0 h-2 border-l border-border pl-1 font-mono text-[10px] leading-none text-muted-foreground" style={{ left: layout.x(t) }}>
                  <span className="absolute -top-3 left-1 whitespace-nowrap">{t} s</span>
                </span>
              ))}
              {markers.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.label}
                  aria-label={m.label}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => (m.onSelect ? m.onSelect() : ctx.player.seek(m.atSec))}
                  className={cn("absolute top-0.5 flex h-4 min-w-4 -translate-x-1/2 items-center justify-center rounded px-1 text-[9px] font-semibold", m.tone === "accent" ? "bg-primary text-primary-foreground" : m.tone === "warn" ? "bg-amber-500 text-black" : "bg-muted-foreground/70 text-background")}
                  style={{ left: layout.x(m.atSec) }}
                >
                  {m.glyph ?? ""}
                </button>
              ))}
            </div>
          </div>
          {tracks.map((t) => (
            <div key={t.id} className="mt-1 flex" style={{ height: t.height }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center bg-card pl-3 text-[11px] text-muted-foreground" style={{ width: LABEL_W }}>
                {t.label}
              </div>
              <div className="relative h-full" style={{ width: layout.width }}>
                <t.Component layout={layout} />
              </div>
            </div>
          ))}
          <Playhead layout={layout} />
        </div>
      </div>
    </section>
  );
}
