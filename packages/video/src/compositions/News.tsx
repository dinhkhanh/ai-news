import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Img, Loop, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadBeVietnamPro } from "@remotion/google-fonts/BeVietnamPro";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { SAFE_ZONES, type Brand, type Caption, type Timeline, type TimelineScene, type Visual } from "../schema";

const beVietnamPro = loadBeVietnamPro("normal", { weights: ["500", "700", "800"], subsets: ["latin", "vietnamese"] });
const inter = loadInter("normal", { weights: ["500", "700", "800"], subsets: ["latin", "vietnamese"] });
const fontFamily = (name: Brand["fonts"]["heading"]) => (name === "Inter" ? inter.fontFamily : beVietnamPro.fontFamily);

const FADE_FRAMES = 8;

/* ---------------------------------------------------------------- visuals */

const SceneVisual: React.FC<{ visual: Visual; durationFrames: number; brand: Brand }> = ({ visual, durationFrames, brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (visual.kind === "solid") {
    return <AbsoluteFill style={{ background: `linear-gradient(160deg, ${brand.colours.primary}, ${brand.colours.background})` }} />;
  }
  if (visual.kind === "image") {
    const scale = visual.kenBurns ? interpolate(frame, [0, durationFrames], [1.04, 1.16], { extrapolateRight: "clamp" }) : 1;
    const tx = visual.kenBurns ? interpolate(frame, [0, durationFrames], [0, -24], { extrapolateRight: "clamp" }) : 0;
    return (
      <AbsoluteFill style={{ backgroundColor: brand.colours.background, overflow: "hidden" }}>
        <Img src={visual.src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale}) translateX(${tx}px)` }} />
      </AbsoluteFill>
    );
  }
  const clipFrames = Math.max(1, Math.round(visual.clipDurationSec * fps));
  const video = (
    <OffthreadVideo
      src={visual.src}
      muted={visual.muted}
      trimBefore={Math.round(visual.trimStartSec * fps)}
      style={{ width: "100%", height: "100%", objectFit: visual.fit }}
      delayRenderTimeoutInMilliseconds={90_000}
    />
  );
  return (
    <AbsoluteFill style={{ backgroundColor: brand.colours.background }}>
      {clipFrames < durationFrames ? <Loop durationInFrames={clipFrames}>{video}</Loop> : video}
    </AbsoluteFill>
  );
};

/* --------------------------------------------------------------- overlays */

const Headline: React.FC<{ text: string; kind: TimelineScene["kind"]; brand: Brand }> = ({ text, kind, brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!text) return null;
  const enter = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  const big = kind === "hook";
  return (
    <div
      style={{
        position: "absolute",
        top: SAFE_ZONES.top + 24,
        left: SAFE_ZONES.left,
        right: SAFE_ZONES.right,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 30}px)`,
        fontFamily: fontFamily(brand.fonts.heading),
      }}
    >
      <div
        style={{
          display: "inline-block",
          background: brand.colours.primary,
          color: brand.colours.text,
          padding: big ? "22px 30px" : "16px 26px",
          borderLeft: `14px solid ${brand.colours.accent}`,
          fontSize: big ? 66 : 54,
          fontWeight: 800,
          lineHeight: 1.18,
          maxWidth: "100%",
          boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        }}
      >
        {text}
      </div>
    </div>
  );
};

const SourceLine: React.FC<{ name: string | null; brand: Brand }> = ({ name, brand }) => {
  if (!brand.showSource || !name) return null;
  return (
    <div
      style={{
        position: "absolute",
        bottom: SAFE_ZONES.bottom - 60,
        left: SAFE_ZONES.left,
        fontFamily: fontFamily(brand.fonts.body),
        fontSize: 30,
        fontWeight: 500,
        color: brand.colours.text,
        opacity: 0.85,
        background: "rgba(0,0,0,.45)",
        padding: "8px 16px",
        borderRadius: 8,
      }}
    >
      Nguồn: {name}
    </div>
  );
};

const Logo: React.FC<{ brand: Brand }> = ({ brand }) =>
  brand.logoSrc ? (
    <Img src={brand.logoSrc} style={{ position: "absolute", top: SAFE_ZONES.top - 120, right: SAFE_ZONES.right - 60, height: 90, objectFit: "contain", opacity: 0.95 }} />
  ) : null;

const Progress: React.FC<{ brand: Brand }> = ({ brand }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  return <div style={{ position: "absolute", top: 0, left: 0, height: 10, width: (frame / durationInFrames) * width, background: brand.colours.accent }} />;
};

/* --------------------------------------------------------------- captions */

const Captions: React.FC<{ captions: Caption[]; brand: Brand }> = ({ captions, brand }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const current = captions.find((c) => ms >= c.startMs && ms < c.endMs);
  if (!current) return null;
  const family = fontFamily(brand.fonts.caption);
  const text = brand.caption.uppercase ? current.text.toUpperCase() : current.text;
  const words = current.words.length ? current.words : [{ w: current.text, s: current.startMs, e: current.endMs }];
  const top = brand.caption.position === "middle" ? height / 2 - 60 : undefined;
  const bottom = brand.caption.position === "bottom" ? SAFE_ZONES.bottom + 30 : undefined;
  return (
    <div style={{ position: "absolute", left: SAFE_ZONES.left, right: SAFE_ZONES.right, top, bottom, display: "flex", justifyContent: "center" }}>
      <div
        style={{
          fontFamily: family,
          fontSize: brand.caption.fontSize,
          fontWeight: 700,
          lineHeight: 1.35, // diacritics stack above Vietnamese capitals; keep the line box tall
          color: brand.colours.text,
          background: brand.colours.captionBg,
          padding: "14px 26px",
          borderRadius: 16,
          textAlign: "center",
          textShadow: "0 2px 8px rgba(0,0,0,.6)",
        }}
      >
        {brand.caption.highlightWords
          ? words.map((w, i) => (
              <span key={i} style={{ color: ms >= w.s && ms < w.e ? brand.colours.captionHighlight : brand.colours.text, marginRight: i < words.length - 1 ? "0.28em" : 0 }}>
                {brand.caption.uppercase ? w.w.toUpperCase() : w.w}
              </span>
            ))
          : text}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ outro */

const Outro: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const { brand } = timeline;
  return (
    <div style={{ position: "absolute", left: SAFE_ZONES.left, right: SAFE_ZONES.right, bottom: SAFE_ZONES.bottom + 140, opacity: enter, fontFamily: fontFamily(brand.fonts.body), color: brand.colours.text }}>
      {brand.outroText ? <div style={{ fontSize: 44, fontWeight: 700 }}>{brand.outroText}</div> : null}
      {timeline.attribution.length ? <div style={{ fontSize: 26, opacity: 0.8, marginTop: 12, lineHeight: 1.4 }}>{timeline.attribution.join(" · ")}</div> : null}
    </div>
  );
};

/* ------------------------------------------------------------ composition */

const SceneFade: React.FC<{ durationFrames: number; children: React.ReactNode }> = ({ durationFrames, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, FADE_FRAMES, durationFrames - FADE_FRAMES, durationFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

/**
 * Editor preview without a mixed track: each scene plays its own voice-over
 * (delayed by the lead-in the mix would apply) and the music loops underneath
 * at the ducked gain. Lambda renders always have `audio.mixSrc`.
 */
const PreviewAudio: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps } = useVideoConfig();
  const music = timeline.audio.musicSrc;
  const gain = Math.pow(10, timeline.audio.musicGainDb / 20);
  return (
    <>
      {timeline.scenes.map((scene, i) =>
        scene.voiceSrc ? (
          <Sequence key={`vo-${scene.id}`} from={scene.from + (i === 0 ? Math.round(0.25 * fps) : 0)} durationInFrames={scene.durationFrames} name={`vo ${scene.id}`}>
            <Audio src={scene.voiceSrc} />
          </Sequence>
        ) : null,
      )}
      {music ? <Audio src={music} loop volume={Math.min(1, gain)} /> : null}
    </>
  );
};

export const News: React.FC<Timeline> = (timeline) => {
  const { brand, scenes, captions, audio } = timeline;
  const last = useMemo(() => scenes[scenes.length - 1], [scenes]);
  return (
    <AbsoluteFill style={{ backgroundColor: brand.colours.background, color: brand.colours.text }}>
      {scenes.map((scene) => (
        <Sequence key={scene.id} from={scene.from} durationInFrames={scene.durationFrames} name={`${scene.id} ${scene.kind}`}>
          <SceneFade durationFrames={scene.durationFrames}>
            <SceneVisual visual={scene.visual} durationFrames={scene.durationFrames} brand={brand} />
            <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 60%, rgba(0,0,0,.55) 100%)" }} />
          </SceneFade>
          <Headline text={scene.headline} kind={scene.kind} brand={brand} />
          {scene.kind === "cta" && scene.id === last?.id ? <Outro timeline={timeline} /> : null}
        </Sequence>
      ))}
      <Captions captions={captions} brand={brand} />
      <SourceLine name={timeline.source.name} brand={brand} />
      <Logo brand={brand} />
      <Progress brand={brand} />
      {audio.mixSrc ? <Audio src={audio.mixSrc} /> : <PreviewAudio timeline={timeline} />}
    </AbsoluteFill>
  );
};
