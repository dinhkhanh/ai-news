import React, { useMemo } from "react";
import { AbsoluteFill, Img, interpolate, Sequence, spring, useCurrentFrame, useVideoConfig } from "remotion";
import {
  balloonEntries,
  beatCamera,
  CARTOON_POP_FRAMES,
  CARTOON_TRANSITION_FRAMES,
  cameraAt,
  cartoonRuns,
  overviewCamera,
  stageBounds,
  stageTransform,
  type Cartoon as CartoonData,
  type CartoonPanel,
  type RunBeat,
} from "../cartoon";
import { COMIC_FONTS, type Panel } from "../comic";
import { ComicPageView } from "../comic-view";
import type { Timeline, TimelineScene } from "../schema";
// Also loads the lettering faces (Itim, Be Vietnam Pro) the balloons use.
import { RemotionImg } from "./ComicPage";

/**
 * A motion comic drawn as a cartoon (0.21.0, `cartoon.ts`): one layer per run of scenes on the same panel, the
 * panel whole with its own balloons popping in as their lines start, a camera gliding between speakers, the next
 * panel sliding in (same page) or turning in (new page) over the previous one, a title card on the opening beat and
 * an end card on the closing one. `News` renders this instead of its own layers when `timeline.cartoon` is set,
 * and keeps the logo and the audio.
 */

const INK = "#111113";
const PAPER = "#FFF8E7";
const TITLE_MAX_FRAMES = 96;

/** Heavy outline for big lettering on top of pictures (same trick as the sfx balloons). */
const outline = (px: number, colour = INK) =>
  [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
    [0, 1.4],
    [1.4, 0],
    [0, -1.4],
    [-1.4, 0],
  ]
    .map(([x, y]) => `${x * px}px ${y * px}px 0 ${colour}`)
    .join(", ");

/** The panel as a one-panel page the size of its stage, so `ComicPageView` draws it exactly as the reader does. */
function stagePage(id: string, panel: CartoonPanel, stage: { x: number; y: number; w: number; h: number }) {
  const shift = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.x - stage.x, y: p.y - stage.y });
  const p: Panel = {
    id,
    rect: { x: -stage.x, y: -stage.y, w: panel.w, h: panel.h },
    script: { size: "medium", shot: "medium", settingId: null, time: "", mood: "", characters: [], description: "" },
    image: { id, key: panel.src, width: panel.imgW, height: panel.imgH },
    variants: [],
    crop: panel.crop ?? undefined,
    error: null,
    lettering: panel.balloons.map((b) => ({ ...b, rect: b.rect ? shift(b.rect) : null, tail: b.tail ? shift(b.tail) : null })),
  };
  return { id, beat: "", layout: "auto" as const, height: stage.h, panels: [p] };
}

/** Blurred, darkened copy of the panel behind it, with a halftone screen: the frame around the panel reads as print. */
const Backdrop: React.FC<{ src: string }> = ({ src }) => (
  <AbsoluteFill style={{ backgroundColor: INK, overflow: "hidden" }}>
    <AbsoluteFill style={{ transform: "scale(1.25)", filter: "blur(44px) saturate(1.25) brightness(.55)" }}>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
    <AbsoluteFill style={{ backgroundImage: "radial-gradient(rgba(0,0,0,.32) 2px, transparent 2.4px)", backgroundSize: "16px 16px" }} />
  </AbsoluteFill>
);

type RunProps = {
  id: string;
  panel: CartoonPanel;
  scenes: TimelineScene[];
  runFrom: number;
  font: CartoonData["font"];
  /** How the panel comes in: none (first panel), a slide (same page), a page turn (new page). */
  entrance: "none" | "slide" | "turn";
  /** +1 = the story reads left to right (the next panel comes from the right). */
  direction: 1 | -1;
};

const PanelRun: React.FC<RunProps> = ({ id, panel, scenes, runFrom, font, entrance, direction }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const stage = useMemo(() => stageBounds(panel), [panel]);
  const page = useMemo(() => stagePage(id, panel, stage), [id, panel, stage]);
  const beats: (RunBeat & { balloon: string | null })[] = useMemo(
    () => scenes.map((s) => ({ from: s.from - runFrom, durationFrames: s.durationFrames, camera: beatCamera(panel, s.cartoon ?? null, direction), balloon: s.cartoon?.balloon ?? null })),
    [scenes, runFrom, panel, direction],
  );
  const opening = useMemo(() => overviewCamera(stage, direction), [stage, direction]);
  const entries = useMemo(() => balloonEntries(panel, beats), [panel, beats]);

  const cam = cameraAt(beats, opening, frame);
  const t = stageTransform(stage, cam);

  const reveal: Record<string, { opacity: number; scale: number }> = {};
  for (const b of panel.balloons) {
    const at = entries[b.id];
    if (at === undefined || frame < at) continue;
    const local = frame - at;
    const sfx = b.kind === "sfx";
    const p = spring({ frame: local, fps, config: sfx ? { damping: 7, stiffness: 220, mass: 0.6 } : { damping: 11, stiffness: 200, mass: 0.55 } });
    reveal[b.id] = { opacity: Math.min(1, local / (CARTOON_POP_FRAMES / 2)), scale: sfx ? 0.2 + 0.8 * p : 0.45 + 0.55 * p };
  }

  // Entrance over the previous panel.
  const enter = entrance === "none" ? 1 : spring({ frame, fps, durationInFrames: CARTOON_TRANSITION_FRAMES + 6, config: { damping: 20, stiffness: 140 } });
  const layer: React.CSSProperties =
    entrance === "slide"
      ? { transform: `translateX(${(1 - enter) * direction * 1080}px)` }
      : entrance === "turn"
        ? { transform: `perspective(2600px) rotateY(${(1 - enter) * -80 * direction}deg)`, transformOrigin: direction === 1 ? "0% 50%" : "100% 50%", opacity: Math.min(1, enter * 2.5) }
        : {};

  return (
    <AbsoluteFill style={{ ...layer, overflow: "hidden", boxShadow: entrance === "none" ? undefined : "0 0 60px rgba(0,0,0,.6)" }}>
      <Backdrop src={panel.src} />
      <div style={{ position: "absolute", left: 0, top: 0, width: stage.w, height: stage.h, transformOrigin: "0 0", transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})` }}>
        {/* Drop shadow of the panel frame. */}
        <div style={{ position: "absolute", left: -stage.x, top: -stage.y, width: panel.w, height: panel.h, boxShadow: `0 ${18 / t.scale}px ${54 / t.scale}px rgba(0,0,0,.55)` }} />
        <ComicPageView format={{ id: "cartoon", width: stage.w, height: stage.h, scroll: false }} font={font} page={page} srcs={{ [panel.src]: panel.src }} ImageComponent={RemotionImg} reveal={reveal} background="transparent" />
      </div>
    </AbsoluteFill>
  );
};

/** The story's title on the opening beat: a caption box in the lettering face, popping in and out. */
const TitleCard: React.FC<{ text: string; font: CartoonData["font"]; durationFrames: number }> = ({ text, font, durationFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 4, fps, config: { damping: 10, stiffness: 160, mass: 0.7 } });
  const out = interpolate(frame, [durationFrames - 10, durationFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const family = `'${COMIC_FONTS[font]?.family ?? "Itim"}', 'Be Vietnam Pro', sans-serif`;
  const size = text.length > 40 ? 64 : text.length > 22 ? 78 : 92;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 130, opacity: out }}>
      <div
        style={{
          maxWidth: 900,
          padding: "26px 44px",
          background: "#FFD43B",
          border: `8px solid ${INK}`,
          borderRadius: 18,
          boxShadow: `14px 16px 0 ${INK}`,
          transform: `rotate(-2.5deg) scale(${pop})`,
          fontFamily: family,
          fontSize: size,
          lineHeight: 1.15,
          color: INK,
          textAlign: "center",
          fontWeight: 700,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/** "Hết" / "Còn tiếp…" over the last panel, with the picture and music credits underneath. */
const EndCard: React.FC<{ text: string; credits: string[]; font: CartoonData["font"] }> = ({ text, credits, font }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dim = interpolate(frame, [0, 14], [0, 0.55], { extrapolateRight: "clamp" });
  const pop = spring({ frame: frame - 6, fps, config: { damping: 9, stiffness: 150, mass: 0.7 } });
  const family = `'${COMIC_FONTS[font]?.family ?? "Itim"}', 'Be Vietnam Pro', sans-serif`;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingBottom: 200 }}>
        <div style={{ transform: `rotate(-4deg) scale(${pop})`, fontFamily: family, fontSize: text.length > 18 ? 110 : text.length > 8 ? 160 : 240, fontWeight: 700, color: PAPER, textShadow: outline(7), textAlign: "center", maxWidth: 940, lineHeight: 1.1 }}>
          {text}
        </div>
        {credits.length ? (
          <div style={{ marginTop: 48, opacity: interpolate(frame, [14, 28], [0, 0.9], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), fontFamily: "'Be Vietnam Pro', sans-serif", fontSize: 34, color: PAPER, textShadow: outline(2), textAlign: "center", maxWidth: 860, lineHeight: 1.4 }}>
            {credits.map((c) => (
              <div key={c}>{c}</div>
            ))}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Cartoon: React.FC<{ timeline: Timeline & { cartoon: CartoonData } }> = ({ timeline }) => {
  const { cartoon, scenes } = timeline;
  const runs = useMemo(() => cartoonRuns(scenes).filter((r) => cartoon.panels[r.panel]), [scenes, cartoon.panels]);
  const direction = cartoon.readingDirection === "rtl" ? -1 : 1;
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  const credits = [...new Set([last?.credit, ...(timeline.attribution ?? [])].filter((c): c is string => Boolean(c)))];
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      {runs.map((r, k) => {
        const panel = cartoon.panels[r.panel];
        const prev = k > 0 ? cartoon.panels[runs[k - 1].panel] : null;
        // Each run stays on screen while the next one comes in over it.
        const tail = k < runs.length - 1 ? CARTOON_TRANSITION_FRAMES + 6 : 0;
        return (
          <Sequence key={`${r.panel}-${r.from}`} from={r.from} durationInFrames={r.durationFrames + tail} name={`panel ${r.panel}`}>
            <PanelRun id={r.panel} panel={panel} scenes={r.scenes} runFrom={r.from} font={cartoon.font} entrance={!prev ? "none" : prev.page === panel.page ? "slide" : "turn"} direction={direction} />
          </Sequence>
        );
      })}
      {first?.kind === "hook" && first.headline ? (
        <Sequence from={0} durationInFrames={Math.min(TITLE_MAX_FRAMES, first.durationFrames)} name="title">
          <TitleCard text={first.headline} font={cartoon.font} durationFrames={Math.min(TITLE_MAX_FRAMES, first.durationFrames)} />
        </Sequence>
      ) : null}
      {last?.kind === "cta" && scenes.length > 1 ? (
        <Sequence from={last.from} durationInFrames={last.durationFrames} name="end">
          <EndCard text={last.headline} credits={credits} font={cartoon.font} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
