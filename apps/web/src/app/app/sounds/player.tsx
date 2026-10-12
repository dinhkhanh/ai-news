"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { formatDuration, licenceInfo } from "@/lib/media/sound-library";
import { cn } from "@/lib/utils";

export type PlayerTrack = { id: string; url: string; title: string; subtitle: string; durationSec: number | null };

/** One `<audio>` for the whole page: starting a sound stops the one playing. */
export function usePlayer() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [track, setTrack] = useState<PlayerTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ at: 0, dur: 0 });

  useEffect(() => {
    const a = new Audio();
    a.preload = "none";
    ref.current = a;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setTime({ at: a.currentTime, dur: Number.isFinite(a.duration) ? a.duration : 0 });
    const onError = () => {
      if (!a.getAttribute("src")) return;
      setPlaying(false);
      toast.error("Không phát được âm thanh này (nguồn không trả tệp)");
    };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onPause);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onTime);
    a.addEventListener("error", onError);
    return () => {
      a.pause();
      a.removeAttribute("src");
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onPause);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onTime);
      a.removeEventListener("error", onError);
    };
  }, []);

  const toggle = useCallback(
    (t: PlayerTrack) => {
      const a = ref.current;
      if (!a) return;
      const blocked = () => toast.error("Trình duyệt chặn phát âm thanh; bấm lại");
      if (track?.id === t.id) {
        if (a.paused) a.play().catch(blocked);
        else a.pause();
        return;
      }
      a.src = t.url;
      setTrack(t);
      setTime({ at: 0, dur: t.durationSec ?? 0 });
      a.play().catch(blocked);
    },
    [track],
  );

  const seek = useCallback((fraction: number) => {
    const a = ref.current;
    if (a && Number.isFinite(a.duration) && a.duration > 0) a.currentTime = Math.min(Math.max(fraction, 0), 1) * a.duration;
  }, []);

  const isPlaying = (id: string) => playing && track?.id === id;
  return { track, playing, time, toggle, seek, isPlaying };
}

export type Player = ReturnType<typeof usePlayer>;

export function PlayButton({ playing, active, label, onClick }: { playing: boolean; active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${playing ? "Tạm dừng" : "Nghe thử"} ${label}`}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_8%)]",
      )}
    >
      {playing ? <Pause className="size-4" fill="currentColor" strokeWidth={0} aria-hidden /> : <Play className="size-4 translate-x-px" fill="currentColor" strokeWidth={0} aria-hidden />}
    </button>
  );
}

const TONE_CLASS = {
  free: "bg-success/10 text-success dark:bg-success/20",
  credit: "bg-primary/10 text-primary dark:bg-primary/20",
  sharealike: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  restricted: "bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  own: "bg-muted text-secondary-foreground",
} as const;

export function LicenceBadge({ licence, version }: { licence: string; version: string | null }) {
  const l = licenceInfo(licence, version);
  return (
    <Badge variant="secondary" className={cn("h-5 rounded-md px-1.5 font-normal", TONE_CLASS[l.tone])} title={l.note}>
      {l.label}
    </Badge>
  );
}

/** Sticky transport for the sound that is playing. */
export function PlayerBar({ player, extra }: { player: Player; extra?: React.ReactNode }) {
  const t = player.track;
  if (!t) return null;
  const dur = player.time.dur || t.durationSec || 0;
  const pct = dur ? Math.min(100, (player.time.at / dur) * 100) : 0;
  return (
    <div role="region" aria-label="Đang phát" className="sticky bottom-16 z-30 mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/95 px-4 py-2.5 shadow-sm backdrop-blur sm:bottom-3">
      <PlayButton playing={player.playing} active label={t.title} onClick={() => player.toggle(t)} />
      <div className="flex min-w-0 flex-[0_1_16rem] flex-col">
        <span className="truncate text-sm font-medium">{t.title}</span>
        <span className="truncate text-xs text-muted-foreground">{t.subtitle}</span>
      </div>
      <div className="flex min-w-48 flex-1 items-center gap-2.5 text-xs text-muted-foreground tabular-nums">
        <span>{formatDuration(player.time.at)}</span>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(pct * 10)}
          onChange={(e) => player.seek(Number(e.target.value) / 1000)}
          aria-label="Vị trí phát"
          className="h-1 flex-1 accent-primary"
        />
        <span>{formatDuration(dur)}</span>
      </div>
      {extra}
    </div>
  );
}
