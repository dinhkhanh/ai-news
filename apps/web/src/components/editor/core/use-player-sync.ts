"use client";
import { useEffect } from "react";
import { useEditor } from "./context";

/**
 * Mirror the mounted Player's position and play state into the time store (call next to the <Preview>).
 * The Player's events fire on every frame; the store only notifies the components that read it.
 */
export function usePlayerSync() {
  const { player, time } = useEditor();
  useEffect(() => {
    const p = player.ref.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => time.set({ frame: e.detail.frame });
    const onPlay = () => time.set({ playing: true });
    const onPause = () => time.set({ playing: false });
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("seeked", onFrame);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    p.addEventListener("ended", onPause);
    time.set({ frame: p.getCurrentFrame(), playing: p.isPlaying() });
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("seeked", onFrame);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("ended", onPause);
    };
  }, [player.ref, time]);
}
