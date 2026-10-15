import React from "react";
import { AbsoluteFill, Img, interpolate, Loop, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import type { Backdrop } from "../schema";

/**
 * Media behind a motion graphic (0.17.0; a picture since 0.23.0), under a
 * scrim so the graphic on top stays legible (`scrim` is plain CSS, a colour or
 * gradient chosen by the engine). Only the backdrop changes when the editor
 * swaps it: the graphic over it is drawn exactly as before.
 *
 * A clip plays muted and cover-fitted to the whole frame (a landscape clip is
 * cropped: it is a backdrop, not the subject), looped when the shot is longer
 * than the clip. A picture is cover-fitted on its face-guard `focus` (the crop
 * of `CoverStill`) with a slow push-in, so it moves a little under the graphic.
 */
export const MotionBackdrop: React.FC<{ backdrop: Backdrop; durationFrames: number; scrim: string }> = ({ backdrop, durationFrames, scrim }) => (
  <AbsoluteFill style={{ overflow: "hidden" }}>
    {backdrop.kind === "image" ? <BackdropStill backdrop={backdrop} durationFrames={durationFrames} /> : <BackdropClip backdrop={backdrop} durationFrames={durationFrames} />}
    <AbsoluteFill style={{ background: scrim }} />
  </AbsoluteFill>
);

const BackdropClip: React.FC<{ backdrop: Extract<Backdrop, { kind: "video" }>; durationFrames: number }> = ({ backdrop, durationFrames }) => {
  const { fps } = useVideoConfig();
  const clipFrames = Math.max(1, Math.round(backdrop.clipDurationSec * fps));
  const clip = (
    <AbsoluteFill>
      <OffthreadVideo src={backdrop.src} muted trimBefore={Math.round((backdrop.trimStartSec ?? 0) * fps)} style={{ width: "100%", height: "100%", objectFit: "cover" }} delayRenderTimeoutInMilliseconds={90_000} />
    </AbsoluteFill>
  );
  return clipFrames < durationFrames ? <Loop durationInFrames={clipFrames}>{clip}</Loop> : clip;
};

const BackdropStill: React.FC<{ backdrop: Extract<Backdrop, { kind: "image" }>; durationFrames: number }> = ({ backdrop, durationFrames }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, Math.max(1, durationFrames)], [1.04, 1.12], { extrapolateRight: "clamp" });
  // Same crop as a picture shot: the box is `zoom` times the frame, shifted like `object-position`.
  const f = backdrop.focus ?? { x: 0.5, y: 0.5, zoom: 1, originX: 0.5, originY: 0.5 };
  const pct = (n: number) => `${n * 100}%`;
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${pct(f.originX)} ${pct(f.originY)}` }}>
      <Img src={backdrop.src} style={{ position: "absolute", width: pct(f.zoom), height: pct(f.zoom), left: pct(-(f.zoom - 1) * f.x), top: pct(-(f.zoom - 1) * f.y), objectFit: "cover", objectPosition: `${pct(f.x)} ${pct(f.y)}` }} />
    </AbsoluteFill>
  );
};
