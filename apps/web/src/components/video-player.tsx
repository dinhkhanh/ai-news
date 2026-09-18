"use client";
import { useEffect, useRef } from "react";
import "plyr/dist/plyr.css";
import "./video-player.css";

type PlyrCtor = typeof import("plyr");
type PlyrInstance = InstanceType<PlyrCtor>;

type Props = {
  src: string;
  poster?: string | null;
  autoPlay?: boolean;
};

/**
 * Plyr (MIT, ~25 KB) over a plain `<video>`: the browser streams the MP4 with
 * range requests, so on mobile data only what is watched gets downloaded, and the
 * progress bar shows how far it has buffered. iOS keeps its native fullscreen player.
 * Loaded lazily by <VideoButton>, so nothing ships until a modal opens.
 */
export function VideoPlayer({ src, poster, autoPlay }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let player: PlyrInstance | null = null;
    let cancelled = false;
    // Plyr's typings declare both `export =` and a default export; the runtime module is ESM with a default.
    void import("plyr").then((mod) => {
      if (cancelled) return;
      const Plyr = ((mod as unknown as { default?: PlyrCtor }).default ?? (mod as unknown as PlyrCtor)) as PlyrCtor;
      player = new Plyr(el, {
        controls: [
          "play-large",
          "play",
          "progress",
          "current-time",
          "mute",
          "volume",
          "settings",
          "pip",
          "airplay",
          "fullscreen",
        ],
        settings: ["speed"],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        fullscreen: { enabled: true, iosNative: true },
        // One time label: the length before playing, then a countdown; tapping it flips to elapsed time.
        displayDuration: true,
        invertTime: true,
        toggleInvert: true,
        // Buffering, not preloading: metadata only until play is pressed.
        autoplay: Boolean(autoPlay),
        hideControls: true,
        resetOnEnd: true,
        i18n: {
          play: "Phát",
          pause: "Tạm dừng",
          mute: "Tắt tiếng",
          unmute: "Bật tiếng",
          settings: "Cài đặt",
          speed: "Tốc độ",
          normal: "Bình thường",
          enterFullscreen: "Toàn màn hình",
          exitFullscreen: "Thoát toàn màn hình",
          download: "Tải về",
          pip: "Hình trong hình",
        },
      });
      // Metadata can land before Plyr listens; replay the event so the length shows before playback (displayDuration).
      player.on("ready", () => {
        if (el.duration) el.dispatchEvent(new Event("durationchange"));
      });
    });
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [src, autoPlay]);
  return (
    <div className="ai-player bg-black" style={{ "--plyr-color-main": "var(--primary)" } as React.CSSProperties}>
      <video ref={ref} playsInline preload="metadata" poster={poster ?? undefined} className="block aspect-[9/16] w-full bg-black">
        <source src={src} type="video/mp4" />
      </video>
    </div>
  );
}
