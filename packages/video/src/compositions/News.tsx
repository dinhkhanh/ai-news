import React, { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, Audio, Img, Loop, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadBeVietnamPro } from "@remotion/google-fonts/BeVietnamPro";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { boxShadowCss, CREDIT_MAX_WIDTH, isLandscape, LANDSCAPE_KEN_BURNS, landscapeLayout, DEFAULT_CAPTION_SHADOW, DEFAULT_HEADLINE_SHADOW, HEADLINE_BAR, headlinePadding, LOGO_MOTION_PERIOD_SEC, OUTPUT, SAFE_ZONES, sourceDisplay, textLayout, type LogoMotion, type Brand, type Caption, type Shot, type Timeline, type TimelineScene, type Visual } from "../schema";

const beVietnamPro = loadBeVietnamPro("normal", { weights: ["500", "700", "800"], subsets: ["latin", "vietnamese"] });
const inter = loadInter("normal", { weights: ["500", "700", "800"], subsets: ["latin", "vietnamese"] });
const fontFamily = (name: Brand["fonts"]["heading"]) => (name === "Inter" ? inter.fontFamily : beVietnamPro.fontFamily);

const FADE_FRAMES = 8;
/** Frames of punch-in at the start of every shot after the first (hard cut + quick settle). */
const PUNCH_FRAMES = 6;

/* ---------------------------------------------------------------- visuals */

type ImageSize = { width: number; height: number };
const imageSizes = new Map<string, ImageSize | null>();

/**
 * Natural size of a still, so the layout can tell landscape from portrait.
 * The render waits for it (`delayRender`); sizes are cached per URL so a
 * shot that mounts again (Player scrubbing, the next chunk) does not reload.
 * A picture that fails to load counts as unknown → cover fit, as before.
 */
function useImageSize(src: string): ImageSize | null | undefined {
  const [size, setSize] = useState<ImageSize | null | undefined>(() => imageSizes.get(src));
  const [handle] = useState(() => (imageSizes.has(src) ? null : delayRender(`image size ${src.slice(0, 80)}`, { timeoutInMilliseconds: 90_000 })));
  useEffect(() => {
    if (imageSizes.has(src)) {
      setSize(imageSizes.get(src));
      if (handle !== null) continueRender(handle);
      return;
    }
    const img = new Image();
    const done = (s: ImageSize | null) => {
      imageSizes.set(src, s);
      setSize(s);
      if (handle !== null) continueRender(handle);
    };
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = src;
    return () => {
      // Unmounted before the load ended: never leave the render waiting.
      if (handle !== null) continueRender(handle);
    };
  }, [src, handle]);
  return size;
}

/** A landscape still: full width on the upper-third line over a blurred, darkened copy of itself. Nothing is cropped. */
const LandscapeStill: React.FC<{ src: string; size: ImageSize; durationFrames: number; kenBurns: boolean; variant: number; brand: Brand }> = ({ src, size, durationFrames, kenBurns, variant, brand }) => {
  const frame = useCurrentFrame();
  const at = landscapeLayout(size.width, size.height);
  const range = variant % 2 === 1 ? LANDSCAPE_KEN_BURNS.out : LANDSCAPE_KEN_BURNS.in;
  const scale = kenBurns ? interpolate(frame, [0, durationFrames], [range[0], range[1]], { extrapolateRight: "clamp" }) : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: brand.colours.background, overflow: "hidden" }}>
      {/* Backdrop: the same picture, cover-fitted and blurred; enlarged so the blur has no soft edges, dimmed so text stays readable. */}
      <AbsoluteFill style={{ transform: `scale(${1.12 * (kenBurns ? scale : 1)})` }}>
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(36px) saturate(1.1)" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "rgba(0,0,0,.42)" }} />
      <div style={{ position: "absolute", left: 0, top: at.top, width: OUTPUT.width, height: at.height, transform: `scale(${scale})`, transformOrigin: "50% 50%", boxShadow: "0 24px 60px rgba(0,0,0,.45)" }}>
        <Img src={src} style={{ display: "block", width: "100%", height: "100%", objectFit: "fill" }} />
      </div>
    </AbsoluteFill>
  );
};

/** A portrait or square still: cover-fitted, anchored on the faces by the face guard (`focus`), with the Ken Burns move. */
const CoverStill: React.FC<{ visual: Extract<Visual, { kind: "image" }>; durationFrames: number; brand: Brand; variant: number }> = ({ visual, durationFrames, brand, variant }) => {
  const frame = useCurrentFrame();
  // Alternate zoom-in / zoom-out and pan direction from shot to shot so consecutive stills do not feel identical.
  const zoomOut = variant % 2 === 1;
  const scale = visual.kenBurns ? interpolate(frame, [0, durationFrames], zoomOut ? [1.18, 1.06] : [1.04, 1.16], { extrapolateRight: "clamp" }) : 1;
  const tx = visual.kenBurns ? interpolate(frame, [0, durationFrames], [0, zoomOut ? 24 : -24], { extrapolateRight: "clamp" }) : 0;
  // Face guard: anchor the cover crop on the faces and zoom around them. The box is `zoom` times the frame,
  // shifted by the same share as `object-position`, which equals a cover fit of the enlarged picture.
  const f = visual.focus ?? { x: 0.5, y: 0.5, zoom: 1, originX: 0.5, originY: 0.5 };
  const pct = (n: number) => `${n * 100}%`;
  return (
    <AbsoluteFill style={{ backgroundColor: brand.colours.background, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `scale(${scale}) translateX(${tx}px)`, transformOrigin: `${pct(f.originX)} ${pct(f.originY)}` }}>
        <Img
          src={visual.src}
          style={{ position: "absolute", width: pct(f.zoom), height: pct(f.zoom), left: pct(-(f.zoom - 1) * f.x), top: pct(-(f.zoom - 1) * f.y), objectFit: "cover", objectPosition: `${pct(f.x)} ${pct(f.y)}` }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const StillVisual: React.FC<{ visual: Extract<Visual, { kind: "image" }>; durationFrames: number; brand: Brand; variant: number }> = (props) => {
  const size = useImageSize(props.visual.src);
  if (size && isLandscape(size.width, size.height)) return <LandscapeStill src={props.visual.src} size={size} durationFrames={props.durationFrames} kenBurns={props.visual.kenBurns !== false} variant={props.variant} brand={props.brand} />;
  return <CoverStill {...props} />;
};

const SceneVisual: React.FC<{ visual: Visual; durationFrames: number; brand: Brand; variant?: number }> = ({ visual, durationFrames, brand, variant = 0 }) => {
  const { fps } = useVideoConfig();
  if (visual.kind === "solid") {
    return <AbsoluteFill style={{ background: `linear-gradient(160deg, ${brand.colours.primary}, ${brand.colours.background})` }} />;
  }
  if (visual.kind === "image") return <StillVisual visual={visual} durationFrames={durationFrames} brand={brand} variant={variant} />;
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

/** Hard cut into each shot with a quick punch-in so the change registers. */
const ShotPunch: React.FC<{ first: boolean; children: React.ReactNode }> = ({ first, children }) => {
  const frame = useCurrentFrame();
  const scale = first ? 1 : interpolate(frame, [0, PUNCH_FRAMES], [1.06, 1], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
};

/** The shots of a scene; a scene without explicit shots is one shot of its `visual`. Tolerates timelines stored before `shots` existed. */
const sceneShots = (scene: TimelineScene): Shot[] => (scene.shots?.length ? scene.shots : [{ from: 0, durationFrames: scene.durationFrames, visual: scene.visual, credit: scene.credit ?? null }]);

/** A scene's shots in sequence. */
const SceneShots: React.FC<{ scene: TimelineScene; brand: Brand }> = ({ scene, brand }) => (
  <>
    {sceneShots(scene).map((shot, i) => (
      <Sequence key={i} from={shot.from} durationInFrames={shot.durationFrames} name={`${scene.id} shot ${i + 1}`}>
        <ShotPunch first={i === 0}>
          <SceneVisual visual={shot.visual} durationFrames={shot.durationFrames} brand={brand} variant={i} />
        </ShotPunch>
      </Sequence>
    ))}
  </>
);

/* --------------------------------------------------------------- overlays */

const Headline: React.FC<{ text: string; kind: TimelineScene["kind"]; brand: Brand }> = ({ text, kind, brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!text) return null;
  const enter = spring({ frame, fps, config: { damping: 200, stiffness: 120 } });
  const at = textLayout(brand, kind).headline;
  const pad = headlinePadding(at.fontSize);
  return (
    <div
      style={{
        position: "absolute",
        // Lower third, right above the captions (or where the kit puts it); anchored by its bottom edge so a long headline grows upwards.
        bottom: OUTPUT.height - at.y1,
        left: at.x,
        width: at.maxX - at.x,
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
          padding: `${pad.y}px ${pad.x}px`,
          borderLeft: `${HEADLINE_BAR}px solid ${brand.colours.accent}`,
          fontSize: at.fontSize,
          fontWeight: 800,
          lineHeight: 1.18,
          maxWidth: "100%",
          boxShadow: boxShadowCss(brand.headline?.shadow ?? DEFAULT_HEADLINE_SHADOW),
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** Where the picture on screen comes from ("Ảnh: VnExpress", "Video: … / Pexels"), bottom-left, for the length of the shot. */
const CreditLine: React.FC<{ text: string; brand: Brand }> = ({ text, brand }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        bottom: SAFE_ZONES.bottom - 60,
        left: SAFE_ZONES.left,
        maxWidth: CREDIT_MAX_WIDTH,
        boxSizing: "border-box",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontFamily: fontFamily(brand.fonts.body),
        fontSize: 30,
        fontWeight: 500,
        color: brand.colours.text,
        opacity: 0.85 * interpolate(frame, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" }),
        background: "rgba(0,0,0,.45)",
        padding: "8px 16px",
        borderRadius: 8,
      }}
    >
      {text}
    </div>
  );
};

/** Each shot's own credit while that shot is on screen; the article itself is credited in the outro. */
const ShotCredits: React.FC<{ scene: TimelineScene; brand: Brand }> = ({ scene, brand }) => {
  if (brand.showSource === false) return null;
  return (
    <>
      {sceneShots(scene).map((shot, i) =>
        shot.credit ? (
          <Sequence key={i} from={shot.from} durationInFrames={shot.durationFrames} name={`${scene.id} credit ${i + 1}`}>
            <CreditLine text={shot.credit} brand={brand} />
          </Sequence>
        ) : null,
      )}
    </>
  );
};

/** Ease in and out (cubic), 0 → 1. */
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The logo turns in from its edge when the video starts, then moves again every
 * `LOGO_MOTION_PERIOD_SEC` – short accents, so it draws the eye without competing
 * with the headline. Pure function of the frame (deterministic on Lambda).
 * Timelines stored before 0.6.0 have no `logoMotion`; they get the default.
 */
function logoTransform(motion: LogoMotion, frame: number, fps: number) {
  if (motion === "none") return { transform: "none", opacity: 0.95 };
  const enter = spring({ frame: frame - Math.round(0.3 * fps), fps, config: { damping: 14, stiffness: 90, mass: 0.9 } });
  const entrance = `rotateY(${(1 - Math.min(1, enter)) * -90}deg) scale(${0.6 + 0.4 * enter})`;
  const period = LOGO_MOTION_PERIOD_SEC * fps;
  // The accent takes the first 0.9 s of every period after the first one (the entrance owns the start of the video).
  const since = frame - period;
  const p = since < 0 ? 1 : Math.min(1, (since % period) / (0.9 * fps));
  const t = frame / fps;
  let accent = "";
  if (motion === "flip") accent = `rotateY(${easeInOut(p) * 360}deg)`;
  else if (motion === "spin") accent = `rotate(${easeInOut(p) * 360}deg)`;
  else if (motion === "pulse") accent = `scale(${1 + 0.16 * Math.abs(Math.sin(2 * Math.PI * p)) * (1 - p)})`; // two beats, the second softer
  else accent = `rotateX(${Math.sin(t * 1.1) * 14}deg) rotateY(${Math.cos(t * 0.8) * 20}deg)`;
  return { transform: `${entrance} ${accent}`, opacity: 0.95 * Math.min(1, enter * 1.5) };
}

const Logo: React.FC<{ brand: Brand }> = ({ brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!brand.logoSrc) return null;
  const { transform, opacity } = logoTransform(brand.logoMotion ?? "flip", frame, fps);
  return (
    // Perspective on the parent gives the turns real depth; the box hugs the image so it turns around its own centre.
    <div style={{ position: "absolute", top: SAFE_ZONES.top - 120, right: SAFE_ZONES.right - 60, height: 90, perspective: 700 }}>
      <Img src={brand.logoSrc} style={{ display: "block", height: 90, objectFit: "contain", opacity, transform, transformOrigin: "50% 50%", backfaceVisibility: "visible" }} />
    </div>
  );
};

/** Brand overlay PNG: full frame, constant for the whole scene (no fade), so consecutive scenes read as one continuous frame. */
const BrandOverlay: React.FC<{ src: string }> = ({ src }) => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <Img src={src} style={{ width: "100%", height: "100%", objectFit: "fill" }} />
  </AbsoluteFill>
);

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
  const at = textLayout(brand, "body").captions;
  // Bottom-anchored blocks keep their lower edge while one / two lines alternate; mid-frame ones keep their upper edge.
  const top = at.anchor === "top" ? at.y0 : undefined;
  const bottom = at.anchor === "bottom" ? height - at.y1 : undefined;
  return (
    <div style={{ position: "absolute", left: at.x0, width: at.x1 - at.x0, top, bottom, display: "flex", justifyContent: at.align === "left" ? "flex-start" : "center" }}>
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
          textAlign: at.align,
          textShadow: "0 2px 8px rgba(0,0,0,.6)",
          boxShadow: boxShadowCss(brand.caption.shadow ?? DEFAULT_CAPTION_SHADOW),
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

/**
 * Closing block of the last scene: the channel line, the article the story
 * comes from (name + URL – the only place the article is credited) and the
 * remaining credits (music).
 */
const Outro: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const { brand } = timeline;
  const source = sourceDisplay(timeline.source);
  const credits = timeline.attribution ?? [];
  return (
    <div style={{ position: "absolute", left: SAFE_ZONES.left, right: SAFE_ZONES.right, bottom: OUTPUT.height - textLayout(brand, "cta").outro.y1, opacity: enter, fontFamily: fontFamily(brand.fonts.body), color: brand.colours.text }}>
      {brand.outroText ? <div style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.2 }}>{brand.outroText}</div> : null}
      <div style={{ fontSize: 30, fontWeight: 700, marginTop: brand.outroText ? 14 : 0, lineHeight: 1.3 }}>
        {timeline.language === "en" ? "Source" : "Nguồn"}: {source.name}
      </div>
      {/* Two lines at most; a long URL is cut, the outlet name above still says where the story is from. */}
      <div style={{ fontSize: 24, opacity: 0.8, marginTop: 4, lineHeight: 1.35, maxHeight: 24 * 1.35 * 2, overflow: "hidden", wordBreak: "break-all" }}>{source.url}</div>
      {credits.length ? <div style={{ fontSize: 24, opacity: 0.8, marginTop: 8, lineHeight: 1.35, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{credits.join(" · ")}</div> : null}
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
            <SceneShots scene={scene} brand={brand} />
            <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 60%, rgba(0,0,0,.55) 100%)" }} />
          </SceneFade>
          {scene.overlay !== false && brand.overlaySrc && brand.overlayLayer !== "top" ? <BrandOverlay src={brand.overlaySrc} /> : null}
          <Headline text={scene.headline} kind={scene.kind} brand={brand} />
          <ShotCredits scene={scene} brand={brand} />
          {scene.kind === "cta" && scene.id === last?.id ? <Outro timeline={timeline} /> : null}
        </Sequence>
      ))}
      <Captions captions={captions} brand={brand} />
      <Logo brand={brand} />
      <Progress brand={brand} />
      {brand.overlaySrc && brand.overlayLayer === "top"
        ? scenes.map((scene) =>
            scene.overlay !== false ? (
              <Sequence key={`overlay-${scene.id}`} from={scene.from} durationInFrames={scene.durationFrames} name={`overlay ${scene.id}`}>
                <BrandOverlay src={brand.overlaySrc!} />
              </Sequence>
            ) : null,
          )
        : null}
      {audio.mixSrc ? <Audio src={audio.mixSrc} /> : <PreviewAudio timeline={timeline} />}
    </AbsoluteFill>
  );
};
