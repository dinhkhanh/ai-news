"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { News } from "@ai-news/video/compositions";
import type { Timeline } from "@ai-news/video/schema";
import { forwardRef } from "react";

/**
 * Remotion Player over the same `News` composition Lambda renders, fed a
 * timeline whose R2 keys were swapped for presigned URLs. When the document's
 * audio layout differs from the stored mix, `audio.mixSrc` is null and the
 * composition plays per-scene voice files instead.
 */
export const Preview = forwardRef<PlayerRef, { timeline: Timeline; width?: number }>(function Preview({ timeline, width = 340 }, ref) {
  return (
    <Player
      ref={ref}
      component={News}
      inputProps={timeline}
      durationInFrames={Math.max(30, timeline.durationFrames)}
      fps={timeline.fps}
      compositionWidth={timeline.width}
      compositionHeight={timeline.height}
      controls
      spaceKeyToPlayOrPause={false}
      showVolumeControls
      clickToPlay
      style={{ width, aspectRatio: "9 / 16", borderRadius: 12, overflow: "hidden", background: "#000" }}
      acknowledgeRemotionLicense
      errorFallback={({ error }) => <div className="p-3 text-xs text-red-400">Lỗi xem trước: {error.message}</div>}
    />
  );
});
