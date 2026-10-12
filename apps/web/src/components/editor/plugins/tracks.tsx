"use client";
import { useState } from "react";
import { sceneShots, shotsMissing, visualKey } from "@/lib/media/editor";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { definePlugin, type TimelineLayout } from "../core/plugin";
import { Thumb } from "../shell/ui";
import { ASSET_DRAG_TYPE } from "./media";

function ShotTrack({ layout }: { layout: TimelineLayout }) {
  const ctx = useEditor();
  const [over, setOver] = useState<string | null>(null);
  const fps = ctx.player.fps;
  return (
    <>
      {ctx.built.timeline.scenes.map((sc, si) => {
        const scene = ctx.doc.scenes[si];
        const shots = sceneShots(scene);
        const short = shotsMissing(scene) > 0;
        return sc.shots.map((sh, i) => {
          const v = shots[i] ?? shots[0];
          const id = `${scene.id}:${i}`;
          const key = visualKey(v);
          const repeated = key ? (ctx.derived.usedKeys[key]?.length ?? 0) > 1 : false;
          const selected = ctx.selection.sceneId === scene.id && ctx.selection.shot === i;
          const t = ctx.derived.thumb(v);
          return (
            <button
              key={id}
              type="button"
              aria-label={`${scene.id} hình ${i + 1}`}
              aria-current={selected}
              onClick={() => {
                ctx.select({ sceneId: scene.id, shot: i });
                ctx.player.seek((sc.from + sh.from) / fps + 0.05);
              }}
              onDragOver={(e) => {
                if (ctx.readOnly || !e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setOver(id);
              }}
              onDragLeave={() => setOver((o) => (o === id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const option = ctx.media.options.find((o) => o.assetId === e.dataTransfer.getData(ASSET_DRAG_TYPE));
                if (option) ctx.media.place(option, scene.id, i);
              }}
              className={cn("absolute top-0 h-full overflow-hidden rounded-md border bg-neutral-800", selected && "ring-2 ring-primary", over === id && "ring-2 ring-sky-400")}
              style={{ left: layout.x((sc.from + sh.from) / fps) + 1, width: Math.max(4, layout.x(sh.durationFrames / fps) - 2) }}
            >
              <span className="absolute inset-0 flex">
                {/* Repeat the thumbnail along long shots so the row reads like film. */}
                {Array.from({ length: Math.max(1, Math.min(6, Math.round(layout.x(sh.durationFrames / fps) / 40))) }, (_, k) => (
                  <span key={k} className="h-full w-10 shrink-0 overflow-hidden opacity-90">
                    <Thumb src={t.src} video={t.video} />
                  </span>
                ))}
              </span>
              <span className="absolute bottom-0 left-0 rounded-tr bg-black/60 px-1 text-[9px] text-white">
                {i === 0 ? scene.id : `#${i + 1}`}
                {v.kind === "solid" ? " · màu" : v.kind === "motion" || v.kind === "hyperframes" ? " · đồ hoạ" : ""}
              </span>
              {short || repeated ? <span className={cn("absolute right-0 bottom-0 left-0 h-1", short ? "bg-amber-500" : "bg-violet-400")} aria-hidden /> : null}
            </button>
          );
        });
      })}
    </>
  );
}

function CaptionTrack({ layout }: { layout: TimelineLayout }) {
  const ctx = useEditor();
  return (
    <>
      {ctx.built.timeline.captions.map((c, i) => (
        <button key={i} type="button" onClick={() => ctx.player.seek(c.startMs / 1000 + 0.02)} title={c.text} className="absolute top-0 h-full truncate rounded border bg-muted px-1 text-left text-[10px] text-muted-foreground hover:text-foreground" style={{ left: layout.x(c.startMs / 1000) + 1, width: Math.max(3, layout.x((c.endMs - c.startMs) / 1000) - 2) }}>
          {c.text}
        </button>
      ))}
    </>
  );
}

function VoiceTrack({ layout }: { layout: TimelineLayout }) {
  const ctx = useEditor();
  return (
    <>
      {ctx.built.timings.map((t, i) => {
        const s = ctx.doc.scenes[i];
        const ms = s.voice?.durationMs ?? s.durationSec * 1000;
        const draft = ctx.drafts.voice[s.id];
        const pending = draft != null && draft.trim() !== s.voiceover.trim();
        return (
          <div key={t.id} title={s.voiceover} className={cn("absolute top-0 flex h-full items-center overflow-hidden rounded border px-1 text-[10px]", s.voice ? "border-sky-500/40 bg-sky-500/15 text-sky-900 dark:text-sky-100" : "border-dashed text-muted-foreground", pending && "border-amber-500")} style={{ left: layout.x(t.atSec) + 1, width: Math.max(3, layout.x(ms / 1000) - 2) }}>
            <span className="truncate">{pending ? "lời mới chưa đọc · " : ""}{s.voiceover}</span>
          </div>
        );
      })}
    </>
  );
}

function MusicTrack({ layout }: { layout: TimelineLayout }) {
  const ctx = useEditor();
  const m = ctx.doc.music;
  if (!m) return <div className="flex h-full items-center rounded border border-dashed px-2 text-[10px] text-muted-foreground" style={{ width: layout.width }}>không nhạc nền</div>;
  return (
    <div className="relative flex h-full items-center overflow-hidden rounded border border-emerald-500/40 bg-emerald-500/10 px-2 text-[10px] text-emerald-900 dark:text-emerald-100" style={{ width: layout.width }}>
      <span className="truncate">
        {m.title} · {m.gainDb} dB dưới lời
      </span>
      <span aria-hidden className="absolute right-0 left-0 border-t border-dashed border-emerald-500/50" style={{ top: `${Math.round(((-m.gainDb - 6) / 18) * 100)}%` }} />
    </div>
  );
}

/** Timeline rows beyond the scenes: shots (drop a library picture on one to swap it), captions, voice-over, music. */
export const tracksPlugin = definePlugin({
  id: "timeline.tracks",
  name: "Hàng dòng thời gian",
  description: "Hàng Hình (kéo hình từ Thư viện thả vào để thay), Phụ đề, Lời đọc và Nhạc trên dòng thời gian.",
  tracks: [
    { id: "shots", label: "Hình", height: 44, order: 20, Component: ShotTrack },
    { id: "captions", label: "Phụ đề", height: 22, order: 30, Component: CaptionTrack },
    { id: "voice", label: "Lời đọc", height: 24, order: 40, Component: VoiceTrack },
    { id: "music", label: "Nhạc", height: 20, order: 50, Component: MusicTrack },
  ],
});
