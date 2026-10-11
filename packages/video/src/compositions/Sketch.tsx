import React, { useId } from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame } from "remotion";
import { OUTPUT, sketchTiming, type SketchStyle } from "../schema";

/*
 * Hand-drawn version of a photo (0.16.0), drawn in the browser from the photo
 * itself – no model, no new detail, the same picture and the same crop:
 * - lines: the grey photo colour-dodged with a blurred negative of itself (the
 *   classic pencil-sketch blend: flat areas go white, edges stay dark), then a
 *   gamma curve to give the strokes weight;
 * - `ink`: harder lines and diagonal hatching in the shadows;
 * - `colour`: the lines multiplied over a soft, brighter wash of the colours;
 * - paper grain, and a slight wobble re-drawn every few frames ("line boil"),
 *   so it reads as drawn by hand rather than filtered.
 * Everything is a pure function of the frame (filters seeded by frame), so
 * Lambda chunks render the same pixels.
 */

/** Paper colour behind the drawing (warm off-white). */
const PAPER = "#f6f1e7";
/** The wobble is re-drawn every this many frames (hand-drawn animation runs "on fours" at 30 fps). */
const BOIL_FRAMES = 4;

/** Paper grain: light grey fractal noise, tiled and multiplied over the drawing. */
const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="3" seed="11" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope=".32" intercept=".74"/><feFuncG type="linear" slope=".32" intercept=".74"/><feFuncB type="linear" slope=".32" intercept=".72"/></feComponentTransfer></filter><rect width="360" height="360" filter="url(#g)"/></svg>`,
)}")`;

/**
 * The sweep: three frames wide, opaque on the left, transparent on the right,
 * with a slanted, torn edge in the middle third. Sliding it from right to left
 * (`mask-position` 90 % → 10 %) uncovers the drawing behind a ragged pencil edge.
 */
const W = OUTPUT.width;
const H = OUTPUT.height;
const SWEEP = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${3 * W}" height="${H}" viewBox="0 0 ${3 * W} ${H}"><filter id="t" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".011 .02" numOctaves="3" seed="5"/><feDisplacementMap in="SourceGraphic" scale="140" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="5"/></filter><path d="M-200 -200 L${1.5 * W + 260} -200 L${1.5 * W - 260} ${H + 200} L-200 ${H + 200} Z" fill="#000" filter="url(#t)"/></svg>`,
)}")`;

/** How the photo is drawn per style. */
const LOOK: Record<SketchStyle, { blur: number; gamma: number; grey: string; hatch: number; wash: boolean }> = {
  pencil: { blur: 6, gamma: 2.6, grey: "grayscale(1) contrast(1.05)", hatch: 0.28, wash: false },
  ink: { blur: 3, gamma: 5.5, grey: "grayscale(1) contrast(1.25)", hatch: 0.6, wash: false },
  colour: { blur: 5, gamma: 3, grey: "grayscale(1) contrast(1.1)", hatch: 0.18, wash: true },
};

/** Splits an `<Img>` style into the box it occupies and how the picture fills it. */
function splitStyle(style: React.CSSProperties) {
  const { objectFit, objectPosition, ...box } = style;
  return { box, fit: { objectFit, objectPosition } as React.CSSProperties };
}

/**
 * One picture, as the photo (`look` null: a plain `<Img>`) or as a drawing of
 * it. `style` is what the `<Img>` would get (box + `objectFit` / `objectPosition`);
 * the drawing occupies exactly the same box with the same crop, so the two can
 * be swapped mid-shot without anything moving.
 */
export const Picture: React.FC<{ src: string; style: React.CSSProperties; look: SketchStyle | null }> = ({ src, style, look }) => {
  const frame = useCurrentFrame();
  const id = `sk${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (!look) return <Img src={src} style={style} />;
  const { box, fit } = splitStyle(style);
  const l = LOOK[look];
  const layer = (extra: React.CSSProperties) => <Img src={src} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", ...fit, ...extra }} />;
  const seed = Math.floor(frame / BOIL_FRAMES);
  const exp = String(l.gamma);
  return (
    <div style={{ position: "relative", ...box, overflow: "hidden", background: PAPER, isolation: "isolate" }}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <filter id={`${id}-lines`} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
          {/* Strokes get weight: light greys pulled down, white paper stays white. */}
          <feComponentTransfer>
            <feFuncR type="gamma" exponent={exp} />
            <feFuncG type="gamma" exponent={exp} />
            <feFuncB type="gamma" exponent={exp} />
          </feComponentTransfer>
        </filter>
        {/* Watercolour wash: few flat tones instead of photographic gradients. */}
        <filter id={`${id}-wash`} colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="discrete" tableValues="0.3 0.5 0.68 0.84 0.96" />
            <feFuncG type="discrete" tableValues="0.3 0.5 0.68 0.84 0.96" />
            <feFuncB type="discrete" tableValues="0.3 0.5 0.68 0.84 0.96" />
          </feComponentTransfer>
        </filter>
        <filter id={`${id}-boil`} x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed={seed} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div style={{ position: "absolute", inset: 0, filter: `url(#${id}-boil)` }}>
        {l.wash ? layer({ filter: `blur(7px) saturate(1.25) brightness(1.3) contrast(.7) url(#${id}-wash)`, opacity: 0.8 }) : null}
        {/* The lines: grey photo ÷ blurred negative (colour dodge), in their own group so the blend sees only these two. */}
        <div style={{ position: "absolute", inset: 0, isolation: "isolate", mixBlendMode: l.wash ? "multiply" : "normal", filter: `url(#${id}-lines)` }}>
          {layer({ filter: l.grey })}
          {layer({ filter: `${l.grey} invert(1) blur(${l.blur}px)`, mixBlendMode: "color-dodge" })}
        </div>
        {/* Hatching in the shadows: diagonal strokes screened with a hard grey copy (white where light), multiplied in. */}
        {l.hatch > 0 ? (
          <div style={{ position: "absolute", inset: 0, isolation: "isolate", mixBlendMode: "multiply", opacity: l.hatch }}>
            {layer({ filter: "grayscale(1) contrast(3) brightness(1.75) blur(1.5px)" })}
            <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(-48deg, #fff 0 9px, #3a3a3a 9px 11px)", mixBlendMode: "screen" }} />
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", inset: 0, backgroundImage: GRAIN, backgroundSize: "360px 360px", mixBlendMode: "multiply" }} />
    </div>
  );
};

/**
 * A still that becomes a drawing: `render(look)` draws the shot (crop, Ken
 * Burns, landscape frame) with every picture as the photo (null) or as the
 * drawing; the drawing is uncovered by the ragged sweep at `sketchTiming`.
 * Both copies follow the same frame-driven motion, so they stay aligned.
 */
export const SketchReveal: React.FC<{ style: SketchStyle; durationFrames: number; render: (look: SketchStyle | null) => React.ReactNode }> = ({ style, durationFrames, render }) => {
  const frame = useCurrentFrame();
  const t = sketchTiming(durationFrames);
  const p = interpolate(frame, [t.start, t.end], [0.9, 0.1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const before = frame < t.start;
  const after = frame >= t.end;
  const mask: React.CSSProperties = after
    ? {}
    : { maskImage: SWEEP, WebkitMaskImage: SWEEP, maskSize: "300% 100%", WebkitMaskSize: "300% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: `${p * 100}% 0`, WebkitMaskPosition: `${p * 100}% 0` };
  // Both copies stay mounted (no image reload mid-shot in the Player); the hidden one is not painted.
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ visibility: after ? "hidden" : "visible" }}>{render(null)}</AbsoluteFill>
      <AbsoluteFill style={{ visibility: before ? "hidden" : "visible", ...mask }}>{render(style)}</AbsoluteFill>
    </AbsoluteFill>
  );
};
