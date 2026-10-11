import React, { useEffect, useRef, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, Img, interpolate, useCurrentFrame } from "remotion";
import { OUTPUT, sketchTiming, type SketchStyle } from "../schema";

/*
 * Hand-drawn version of a photo (0.16.0), drawn in the browser from the photo
 * itself – no model, no new detail, the same picture and the same crop:
 * - lines: the grey photo colour-dodged with a blurred negative of itself (the
 *   classic pencil-sketch blend: flat areas go white, edges stay dark), raised
 *   to a power to give the strokes weight;
 * - `ink`: harder lines and diagonal hatching in the shadows;
 * - `colour`: the lines multiplied over a soft, posterised wash of the colours;
 * - paper grain, and a slight wobble that changes every few frames ("line
 *   boil"), so it reads as drawn by hand rather than filtered.
 *
 * Cost (0.16.1): Lambda renders on the CPU, where blurs, blends and SVG
 * turbulence over a 1080×1920 frame take seconds, so recomputing them every
 * frame timed renders out. The drawing is therefore made once per picture
 * (`drawSketch`, canvas 2D), as `BOIL_VARIANTS` canvases that differ only in
 * their wobble, and every frame just shows one of them with the shot's crop
 * and Ken Burns – about the cost of a plain photo. Deterministic (fixed seeds),
 * so Lambda chunks render the same pixels.
 */

/** Paper colour behind the drawing (warm off-white). */
const PAPER = "#f6f1e7";
/** The wobble changes every this many frames (hand-drawn animation runs "on fours" at 30 fps)… */
const BOIL_FRAMES = 4;
/** …cycling through this many pre-drawn variants. */
const BOIL_VARIANTS = 3;
/** Longest side of the drawing in px: sharp under the face-guard zoom and the Ken Burns, bounded in memory. */
const MAX_DRAWING_PX = 2200;

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

/** How the photo is drawn per style (lengths in px of the 1080-wide frame; `power` darkens the strokes). */
const LOOK: Record<SketchStyle, { blur: number; power: number; grey: string; hatch: number; wash: boolean }> = {
  pencil: { blur: 6, power: 3, grey: "grayscale(1) contrast(1.05)", hatch: 0.28, wash: false },
  ink: { blur: 3, power: 5, grey: "grayscale(1) contrast(1.25)", hatch: 0.6, wash: false },
  colour: { blur: 5, power: 3, grey: "grayscale(1) contrast(1.1)", hatch: 0.18, wash: true },
};

type Drawing = { width: number; height: number; variants: HTMLCanvasElement[] };

/* ------------------------------------------------------------ drawing */

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d")!;

/** Deterministic noise (mulberry32), so every Lambda chunk draws the same grain. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paper grain tile: light grey noise, multiplied over the drawing. */
function grainTile() {
  const size = 256;
  const c = canvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const rnd = prng(11);
  for (let i = 0; i < size * size; i++) {
    // Two octaves: fine speckle on a softer blotch.
    const v = 0.78 + 0.22 * (0.65 * rnd() + 0.35 * rnd());
    img.data[i * 4] = Math.round(255 * v);
    img.data[i * 4 + 1] = Math.round(255 * v);
    img.data[i * 4 + 2] = Math.round(250 * v);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Hatching tile: one dark diagonal stroke on white, repeating. */
function hatchTile(px: number) {
  const step = Math.max(4, Math.round(11 * px));
  const c = canvas(step, step);
  const g = ctx2d(c);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, step, step);
  g.strokeStyle = "#3a3a3a";
  g.lineWidth = Math.max(1, 2 * px);
  for (const o of [-step, 0, step]) {
    g.beginPath();
    g.moveTo(o, step);
    g.lineTo(o + step, 0);
    g.stroke();
  }
  return c;
}

/** SVG filters the canvas `filter` refers to by id: the wash posterise and the wobble variants. */
function svgFilters(id: string, px: number) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  const levels = "0.3 0.5 0.68 0.84 0.96";
  svg.innerHTML =
    `<filter id="${id}-wash" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="discrete" tableValues="${levels}"/><feFuncG type="discrete" tableValues="${levels}"/><feFuncB type="discrete" tableValues="${levels}"/></feComponentTransfer></filter>` +
    Array.from(
      { length: BOIL_VARIANTS },
      (_, k) =>
        `<filter id="${id}-boil${k}" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="${(0.018 / px).toFixed(5)}" numOctaves="2" seed="${k + 1}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${(6 * px).toFixed(2)}" xChannelSelector="R" yChannelSelector="G"/></filter>`,
    ).join("");
  document.body.appendChild(svg);
  return svg;
}

let drawingSeq = 0;

/**
 * The drawing of a loaded photo, once: lines (colour dodge, then multiplied
 * with themselves `power` times), wash, hatching, grain, then the wobble
 * variants. Lengths are in px of the 1080-wide frame, converted with `px`
 * (drawing px per frame px at the picture's displayed size), so the strokes
 * look the same whatever the photo's resolution. The canvases stay tainted by
 * the cross-origin photo – fine: pixels are only drawn, never read back.
 */
function drawSketch(img: HTMLImageElement, style: SketchStyle): Drawing {
  const l = LOOK[style];
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const c = Math.min(1, MAX_DRAWING_PX / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * c));
  const h = Math.max(1, Math.round(nh * c));
  // Displayed scale of the photo: landscape = full width, portrait / square = cover of the 9:16 frame.
  const shown = nw > nh ? OUTPUT.width / nw : Math.max(OUTPUT.width / nw, OUTPUT.height / nh);
  const px = c / shown;
  const id = `sk${++drawingSeq}`;
  const defs = svgFilters(id, px);
  try {
    // Lines: grey ÷ blurred negative (colour dodge), then strokes darkened by multiplying with themselves.
    const lines = canvas(w, h);
    const lg = ctx2d(lines);
    lg.filter = l.grey;
    lg.drawImage(img, 0, 0, w, h);
    lg.globalCompositeOperation = "color-dodge";
    lg.filter = `${l.grey} invert(1) blur(${(l.blur * px).toFixed(2)}px)`;
    lg.drawImage(img, 0, 0, w, h);
    lg.filter = "none";
    const once = canvas(w, h);
    ctx2d(once).drawImage(lines, 0, 0);
    lg.globalCompositeOperation = "multiply";
    for (let i = 1; i < l.power; i++) lg.drawImage(once, 0, 0);

    const out = canvas(w, h);
    const og = ctx2d(out);
    og.fillStyle = PAPER;
    og.fillRect(0, 0, w, h);
    if (l.wash) {
      og.filter = `blur(${(7 * px).toFixed(2)}px) saturate(1.25) brightness(1.3) contrast(.7) url(#${id}-wash)`;
      og.globalAlpha = 0.8;
      og.drawImage(img, 0, 0, w, h);
      og.filter = "none";
      og.globalAlpha = 1;
    }
    // Lines multiplied onto paper (and wash): white stays paper, strokes stay dark.
    og.globalCompositeOperation = "multiply";
    og.drawImage(lines, 0, 0);
    if (l.hatch > 0) {
      // Hatching in the shadows: a hard grey copy (white where light) screened with diagonal strokes, multiplied in.
      const hatch = canvas(w, h);
      const hg = ctx2d(hatch);
      hg.filter = `grayscale(1) contrast(3) brightness(1.75) blur(${(1.5 * px).toFixed(2)}px)`;
      hg.drawImage(img, 0, 0, w, h);
      hg.filter = "none";
      hg.globalCompositeOperation = "screen";
      hg.fillStyle = hg.createPattern(hatchTile(px), "repeat")!;
      hg.fillRect(0, 0, w, h);
      og.globalAlpha = l.hatch;
      og.drawImage(hatch, 0, 0);
      og.globalAlpha = 1;
    }
    const grain = og.createPattern(grainTile(), "repeat")!;
    grain.setTransform(new DOMMatrix().scale(Math.max(1, px)));
    og.fillStyle = grain;
    og.fillRect(0, 0, w, h);

    // The wobble variants: the same drawing, displaced by a differently seeded noise each.
    const variants = Array.from({ length: BOIL_VARIANTS }, (_, k) => {
      const v = canvas(w, h);
      const vg = ctx2d(v);
      vg.fillStyle = PAPER;
      vg.fillRect(0, 0, w, h);
      vg.filter = `url(#${id}-boil${k})`;
      vg.drawImage(out, 0, 0);
      return v;
    });
    return { width: w, height: h, variants };
  } finally {
    defs.remove();
  }
}

/** Drawings by style + URL, kept for the few pictures around the playhead (a landscape still shows two copies). */
const drawings = new Map<string, Promise<Drawing | null>>();
const KEEP_DRAWINGS = 4;

function loadDrawing(src: string, style: SketchStyle): Promise<Drawing | null> {
  const key = `${style} ${src}`;
  const hit = drawings.get(key);
  if (hit) {
    // Most recently used goes last.
    drawings.delete(key);
    drawings.set(key, hit);
    return hit;
  }
  const p = new Promise<Drawing | null>((resolve) => {
    const img = new Image();
    img.decoding = "sync";
    img.onload = () => {
      try {
        resolve(img.naturalWidth > 0 ? drawSketch(img, style) : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  drawings.set(key, p);
  while (drawings.size > KEEP_DRAWINGS) drawings.delete(drawings.keys().next().value!);
  return p;
}

/* ------------------------------------------------------------ components */

/** Splits an `<Img>` style into the box it occupies and how the picture fills it. */
function splitStyle(style: React.CSSProperties) {
  const { objectFit, objectPosition, ...box } = style;
  return { box, fit: { objectFit, objectPosition } as React.CSSProperties };
}

/** The drawing in an `<Img>`'s box: one canvas per wobble variant, the frame picks which one shows. */
const Drawn: React.FC<{ src: string; style: React.CSSProperties; look: SketchStyle }> = ({ src, style, look }) => {
  const frame = useCurrentFrame();
  const refs = useRef<Array<HTMLCanvasElement | null>>([]);
  const [failed, setFailed] = useState(false);
  const [handle] = useState(() => delayRender(`sketch ${src.slice(0, 80)}`, { timeoutInMilliseconds: 90_000 }));
  useEffect(() => {
    let live = true;
    void loadDrawing(src, look).then((d) => {
      if (live) {
        if (!d) setFailed(true);
        else
          d.variants.forEach((v, k) => {
            const el = refs.current[k];
            if (!el) return;
            el.width = d.width;
            el.height = d.height;
            ctx2d(el).drawImage(v, 0, 0);
          });
      }
      continueRender(handle);
    });
    return () => {
      live = false;
      // Unmounted before the drawing was ready: never leave the render waiting.
      continueRender(handle);
    };
  }, [src, look, handle]);
  if (failed) return <Img src={src} style={style} />;
  const { box, fit } = splitStyle(style);
  const shown = Math.floor(frame / BOIL_FRAMES) % BOIL_VARIANTS;
  return (
    <div style={{ position: "relative", ...box, overflow: "hidden", background: PAPER }}>
      {Array.from({ length: BOIL_VARIANTS }, (_, k) => (
        <canvas
          key={k}
          ref={(el) => {
            refs.current[k] = el;
          }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", ...fit, visibility: k === shown ? "visible" : "hidden" }}
        />
      ))}
    </div>
  );
};

/**
 * One picture, as the photo (`look` null: a plain `<Img>`) or as a drawing of
 * it. `style` is what the `<Img>` would get (box + `objectFit` / `objectPosition`);
 * the drawing occupies exactly the same box with the same crop, so the two can
 * be swapped mid-shot without anything moving.
 */
export const Picture: React.FC<{ src: string; style: React.CSSProperties; look: SketchStyle | null }> = ({ src, style, look }) =>
  look ? <Drawn src={src} style={style} look={look} /> : <Img src={src} style={style} />;

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
