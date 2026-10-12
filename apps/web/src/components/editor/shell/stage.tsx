"use client";
import { useState } from "react";
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import type { Timeline } from "@ai-news/video/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePlayerRef, usePlayerTime, useEditor } from "../core/context";
import { usePlayerSync } from "../core/use-player-sync";
import { Preview } from "../preview";
import { Note, timecode } from "./ui";

/** Transport: scene jumps, play / pause, timecode, mute. Re-renders with the playhead only. */
function Transport() {
  const ctx = useEditor();
  const { frame, playing } = usePlayerTime();
  const [muted, setMuted] = useState(false);
  const sec = frame / ctx.player.fps;
  const scenes = ctx.built.timings;
  const idx = Math.max(0, scenes.findLastIndex((t) => t.fromFrame <= frame));
  const jump = (d: number) => {
    const t = scenes[Math.min(scenes.length - 1, Math.max(0, idx + d))];
    if (!t) return;
    ctx.player.seekScene(t.id);
    ctx.select({ sceneId: t.id });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
      <Button variant="ghost" size="icon-sm" onClick={() => jump(-1)} aria-label="Cảnh trước ([)" title="Cảnh trước ([)">
        <SkipBack />
      </Button>
      <Button size="icon" className="rounded-full" onClick={ctx.player.toggle} aria-label={playing ? "Tạm dừng (Space)" : "Phát (Space)"}>
        {playing ? <Pause /> : <Play />}
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={() => jump(1)} aria-label="Cảnh sau (])" title="Cảnh sau (])">
        <SkipForward />
      </Button>
      <span className="font-mono text-xs tabular-nums">
        {timecode(sec)} <span className="text-muted-foreground">/ {timecode(ctx.durationSec)}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          const p = ctx.player.ref.current;
          if (!p) return;
          if (muted) p.unmute();
          else p.mute();
          setMuted(!muted);
        }}
        aria-label={muted ? "Bật tiếng" : "Tắt tiếng"}
      >
        {muted ? <VolumeX /> : <Volume2 />}
      </Button>
      <span className="ml-auto">
        {ctx.derived.mixUsable ? <Badge variant="outline">âm thanh đã trộn</Badge> : <Badge variant="secondary" title="Bản xem trước phát lời từng cảnh và nhạc riêng; lưu để trộn lại">lời + nhạc chưa trộn</Badge>}
      </span>
    </div>
  );
}

/** The preview: the real `News` composition in the Player, overlay plugins above it, and the transport. */
export function Stage({ timeline, className }: { timeline: Timeline; className?: string }) {
  const ctx = useEditor();
  const playerRef = usePlayerRef();
  usePlayerSync();
  const overlays = ctx.plugins.contributions.overlays;
  return (
    <main aria-label="Xem trước" className={cn("flex min-h-0 min-w-0 flex-col bg-neutral-950 text-neutral-100", className)}>
      {overlays.length ? (
        <div role="group" aria-label="Lớp phủ hướng dẫn" className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
          {overlays.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={Boolean(ctx.ui.overlays[o.id])}
              onClick={() => ctx.ui.toggleOverlay(o.id)}
              className={cn("min-h-7 rounded-full border px-2.5 text-xs transition-colors pointer-coarse:min-h-9", ctx.ui.overlays[o.id] ? "border-sky-400 bg-sky-400/15 text-sky-100" : "border-white/15 text-neutral-400 hover:text-neutral-100")}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center p-2" style={{ containerType: "size" }}>
        <div className="relative" style={{ width: "min(100cqw, calc(100cqh * 9 / 16))", aspectRatio: "9 / 16" }}>
          <Preview ref={playerRef} timeline={timeline} controls={false} style={{ width: "100%", height: "100%" }} />
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
            {overlays.filter((o) => ctx.ui.overlays[o.id]).map((o) => (
              <o.Component key={o.id} />
            ))}
          </div>
        </div>
      </div>
      <div className="text-neutral-100 [&_.text-muted-foreground]:text-neutral-400">
        <Transport />
      </div>
      {ctx.props.lastError || ctx.busy ? (
        <div className="space-y-1 px-3 pb-2">
          {ctx.props.lastError ? <Note tone="danger">{ctx.props.lastError}</Note> : null}
          {ctx.busy ? <p className="text-xs text-neutral-400">Đang chạy bước {ctx.props.busyStep}… phiên bản mới tự mở khi xong.</p> : null}
        </div>
      ) : null}
    </main>
  );
}
