import React from "react";
import { AbsoluteFill, Loop, OffthreadVideo, useVideoConfig } from "remotion";
import type { Backdrop } from "../schema";

/**
 * Real footage behind a motion graphic (0.17.0): the clip muted and
 * cover-fitted to the whole frame (a landscape clip is cropped: it is a
 * backdrop, not the subject), looped when the shot is longer than the clip,
 * under a scrim so the graphic on top stays legible. `scrim` is plain CSS
 * (a colour or gradient) chosen by the engine.
 */
export const MotionBackdrop: React.FC<{ backdrop: Backdrop; durationFrames: number; scrim: string }> = ({ backdrop, durationFrames, scrim }) => {
  const { fps } = useVideoConfig();
  const clipFrames = Math.max(1, Math.round(backdrop.clipDurationSec * fps));
  const clip = (
    <AbsoluteFill>
      <OffthreadVideo src={backdrop.src} muted trimBefore={Math.round((backdrop.trimStartSec ?? 0) * fps)} style={{ width: "100%", height: "100%", objectFit: "cover" }} delayRenderTimeoutInMilliseconds={90_000} />
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {clipFrames < durationFrames ? <Loop durationInFrames={clipFrames}>{clip}</Loop> : clip}
      <AbsoluteFill style={{ background: scrim }} />
    </AbsoluteFill>
  );
};
