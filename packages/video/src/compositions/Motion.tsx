import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, Sequence, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { formatMotionNumber, normaliseMotionSpec, type MotionBeat, type MotionElement, type MotionItem, type MotionSpec } from "../motion";
import { motionArea, type Backdrop, type Brand, type TimelineScene } from "../schema";
import { MotionBackdrop } from "./MotionBackdrop";

/**
 * Motion graphic of one shot (engine `remotion`): the spec's beats one after
 * another (each replaces the previous with a short cross-fade), the elements
 * of a beat stacked in the motion area (`motionArea`: clear of the top bar,
 * the captions and the outro) and entering on their own delay. Everything is
 * a pure function of the frame, so Lambda chunks render identically.
 */

const BEAT_FADE = 8;
type Palette = { bg: string; bg2: string; text: string; muted: string; accent: string; card: string; line: string };

function palette(mood: MotionSpec["mood"], brand: Brand): Palette {
  const c = brand.colours;
  if (mood === "light") return { bg: "#f6f3ec", bg2: "#e9e4d8", text: "#111827", muted: "#4b5563", accent: c.accent, card: "#ffffff", line: "rgba(17,24,39,.12)" };
  if (mood === "dark") return { bg: "#07090f", bg2: "#141a2a", text: "#ffffff", muted: "rgba(255,255,255,.72)", accent: c.accent, card: "rgba(255,255,255,.07)", line: "rgba(255,255,255,.12)" };
  if (mood === "alert") return { bg: "#2a0508", bg2: "#6b0f17", text: "#ffffff", muted: "rgba(255,255,255,.78)", accent: "#ffd23f", card: "rgba(0,0,0,.28)", line: "rgba(255,255,255,.14)" };
  return { bg: c.background, bg2: c.primary, text: c.text, muted: "rgba(255,255,255,.75)", accent: c.accent, card: "rgba(255,255,255,.08)", line: "rgba(255,255,255,.12)" };
}

/* ------------------------------------------------------------ background */

/** The mood's background colour at `pct` % opacity (the brand colour may itself be translucent: no string maths on it). */
const tint = (colour: string, pct: number) => `color-mix(in srgb, ${colour} ${pct}%, transparent)`;

const Background: React.FC<{ spec: MotionSpec; p: Palette; images: string[]; backdrop: Backdrop | null }> = ({ spec, p, images, backdrop }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const t = frame / fps;
  // Real footage: tinted by the mood, darker at the top bar and towards the captions, lighter in the middle.
  if (spec.background === "video" && backdrop) {
    return <MotionBackdrop backdrop={backdrop} durationFrames={durationInFrames} scrim={`linear-gradient(180deg, ${tint(p.bg, 78)} 0%, ${tint(p.bg, 50)} 40%, ${tint(p.bg, 58)} 65%, ${tint(p.bg, 88)} 100%)`} />;
  }
  const img = spec.background === "image" && spec.backgroundImage != null ? images[spec.backgroundImage] : undefined;
  const base = <AbsoluteFill style={{ background: `linear-gradient(165deg, ${p.bg2} 0%, ${p.bg} 70%)` }} />;
  if (img) {
    const scale = interpolate(frame, [0, durationInFrames], [1.08, 1.18]);
    return (
      <AbsoluteFill style={{ background: p.bg, overflow: "hidden" }}>
        <AbsoluteFill style={{ transform: `scale(${scale})`, filter: "blur(10px) saturate(1.1)" }}>
          <Img src={img} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
        <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.bg}cc 0%, ${p.bg}99 45%, ${p.bg}ee 100%)` }} />
      </AbsoluteFill>
    );
  }
  if (spec.background === "grid") {
    const shift = (t * 24) % 90;
    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {base}
        <AbsoluteFill
          style={{
            backgroundImage: `linear-gradient(${p.line} 2px, transparent 2px), linear-gradient(90deg, ${p.line} 2px, transparent 2px)`,
            backgroundSize: "90px 90px",
            backgroundPosition: `0 ${shift}px`,
            maskImage: "radial-gradient(ellipse at 50% 40%, black 30%, transparent 80%)",
            WebkitMaskImage: "radial-gradient(ellipse at 50% 40%, black 30%, transparent 80%)",
          }}
        />
      </AbsoluteFill>
    );
  }
  if (spec.background === "dots") {
    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {base}
        <AbsoluteFill style={{ backgroundImage: `radial-gradient(${p.line} 3px, transparent 3.5px)`, backgroundSize: "54px 54px", backgroundPosition: `${(t * 10) % 54}px ${(t * 16) % 54}px`, opacity: 0.9 }} />
      </AbsoluteFill>
    );
  }
  if (spec.background === "rays") {
    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {base}
        <AbsoluteFill style={{ left: -540, top: -400, width: 2160, height: 2700, background: `repeating-conic-gradient(from ${t * 6}deg at 50% 45%, ${p.line} 0deg 6deg, transparent 6deg 18deg)`, opacity: 0.8 }} />
      </AbsoluteFill>
    );
  }
  // gradient: two soft blobs drifting slowly.
  const ax = 300 + Math.sin(t * 0.5) * 140;
  const ay = 520 + Math.cos(t * 0.4) * 120;
  const bx = 780 + Math.cos(t * 0.35) * 160;
  const by = 1250 + Math.sin(t * 0.45) * 140;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {base}
      <div style={{ position: "absolute", left: ax - 450, top: ay - 450, width: 900, height: 900, borderRadius: "50%", background: p.accent, opacity: 0.22, filter: "blur(140px)" }} />
      <div style={{ position: "absolute", left: bx - 500, top: by - 500, width: 1000, height: 1000, borderRadius: "50%", background: p.bg2, opacity: 0.55, filter: "blur(160px)" }} />
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------- entering */

/** 0 → 1 progress of an element that appears `delay` seconds into its beat. */
function useEnter(delaySec: number, damping = 18) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - Math.round(delaySec * fps);
  return { local, p: local < 0 ? 0 : spring({ frame: local, fps, config: { damping, stiffness: 120, mass: 0.8 } }) };
}

function enterStyle(enter: MotionElement["enter"], p: number): React.CSSProperties {
  const o = Math.min(1, p * 1.4);
  if (enter === "pop") return { opacity: o, transform: `scale(${0.6 + 0.4 * p})` };
  if (enter === "slide") return { opacity: o, transform: `translateX(${(1 - p) * -120}px)` };
  if (enter === "wipe") return { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` };
  if (enter === "fade") return { opacity: p };
  if (enter === "type") return { opacity: 1 };
  return { opacity: o, transform: `translateY(${(1 - p) * 60}px)` };
}

/** Text with the `emphasis` words in the accent colour; `type` reveals it letter by letter. */
const RichText: React.FC<{ text: string; emphasis: string[] | null; accent: string; reveal?: number }> = ({ text, emphasis, accent, reveal }) => {
  const shown = reveal == null ? text : text.slice(0, Math.round(text.length * Math.min(1, Math.max(0, reveal))));
  const marks = (emphasis ?? []).map((w) => w.trim()).filter(Boolean);
  if (!marks.length) return <>{shown}</>;
  const re = new RegExp(`(${marks.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {shown.split(re).map((part, i) => (marks.some((m) => m.toLowerCase() === part.toLowerCase()) ? <span key={i} style={{ color: accent }}>{part}</span> : <React.Fragment key={i}>{part}</React.Fragment>))}
    </>
  );
};

/** Count-up of a number over ~1.1 s after the element enters. */
function useCount(value: number, local: number) {
  const { fps } = useVideoConfig();
  return value * interpolate(local, [0, Math.round(1.1 * fps)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
}

type ElProps = { el: MotionElement; p: Palette; font: string; language: "vi" | "en"; images: string[]; width: number };

/* -------------------------------------------------------------- elements */

const Kicker: React.FC<ElProps> = ({ el, p }) => (
  <div style={{ alignSelf: "flex-start", background: p.accent, color: "#111", fontSize: 34, fontWeight: 800, letterSpacing: 3, textTransform: "uppercase", padding: "10px 22px", borderRadius: 10 }}>{el.label ?? el.text}</div>
);

const Title: React.FC<ElProps> = ({ el, p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = el.text ?? "";
  const size = text.length > 70 ? 70 : text.length > 42 ? 84 : 104;
  const marks = new Set((el.emphasis ?? []).flatMap((w) => w.toLowerCase().split(/\s+/)));
  const start = Math.round(el.delay * fps);
  // Words rise in one after another (3 frames apart): the kinetic-type look.
  return (
    <div style={{ fontSize: size, fontWeight: 900, lineHeight: 1.08, letterSpacing: -1, color: p.text }}>
      {text.split(/\s+/).map((w, i) => {
        const q = spring({ frame: frame - start - i * 3, fps, config: { damping: 16, stiffness: 140 } });
        return (
          <span key={i} style={{ display: "inline-block", marginRight: "0.25em", opacity: Math.min(1, q * 1.5), transform: `translateY(${(1 - q) * 50}px)`, color: marks.has(w.toLowerCase().replace(/[.,!?:;]+$/, "")) ? p.accent : undefined }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};

const Text: React.FC<ElProps & { reveal: number | undefined }> = ({ el, p, reveal }) => (
  <div style={{ fontSize: (el.text ?? "").length > 120 ? 44 : 52, fontWeight: 600, lineHeight: 1.3, color: p.text }}>
    <RichText text={el.text ?? ""} emphasis={el.emphasis} accent={p.accent} reveal={reveal} />
  </div>
);

const Stat: React.FC<ElProps & { local: number }> = ({ el, p, language, local }) => {
  const v = useCount(el.value ?? 0, local);
  const num = formatMotionNumber(v, el.decimals ?? 0, language);
  const size = num.length + (el.prefix?.length ?? 0) + (el.suffix?.length ?? 0) > 9 ? 150 : 210;
  return (
    <div>
      <div style={{ fontSize: size, fontWeight: 900, lineHeight: 1, color: p.accent, letterSpacing: -4, fontVariantNumeric: "tabular-nums" }}>
        {el.prefix ? <span style={{ fontSize: size * 0.55 }}>{el.prefix}</span> : null}
        {num}
        {el.suffix ? <span style={{ fontSize: size * 0.42, marginLeft: 8 }}>{el.suffix}</span> : null}
      </div>
      {el.text ? <div style={{ marginTop: 18, fontSize: 48, fontWeight: 700, lineHeight: 1.25, color: p.text }}><RichText text={el.text} emphasis={el.emphasis} accent={p.accent} /></div> : null}
    </div>
  );
};

const Bars: React.FC<ElProps & { local: number }> = ({ el, p, language, local, width }) => {
  const { fps } = useVideoConfig();
  const items = el.items ?? [];
  const max = Math.max(1e-9, ...items.map((it) => Math.abs(it.value ?? 0)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {el.label ? <div style={{ fontSize: 32, fontWeight: 600, color: p.muted }}>{el.label}</div> : null}
      {items.map((it, i) => {
        const at = local - i * Math.round(0.25 * fps);
        const grow = interpolate(at, [0, Math.round(0.9 * fps)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
        const value = (it.value ?? 0) * grow;
        return (
          <div key={i} style={{ opacity: at < 0 ? 0 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 38, fontWeight: 700, color: p.text, marginBottom: 8 }}>
              <span>{it.label}</span>
              <span style={{ color: i === 0 ? p.accent : p.text, fontVariantNumeric: "tabular-nums" }}>
                {el.prefix ?? ""}
                {formatMotionNumber(value, el.decimals ?? 0, language)}
                {el.suffix ?? ""}
              </span>
            </div>
            <div style={{ height: 34, width, background: p.card, borderRadius: 17, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(Math.abs(it.value ?? 0) / max) * 100 * grow}%`, background: i === 0 ? p.accent : p.text, opacity: i === 0 ? 1 : 0.55, borderRadius: 17 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const List: React.FC<ElProps & { local: number }> = ({ el, p, local }) => {
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {(el.items ?? []).map((it, i) => {
        const q = spring({ frame: local - i * Math.round(0.4 * fps), fps, config: { damping: 18, stiffness: 120 } });
        return (
          <div key={i} style={{ display: "flex", gap: 24, alignItems: "flex-start", opacity: Math.min(1, q * 1.4), transform: `translateX(${(1 - q) * -60}px)` }}>
            <div style={{ flex: "none", width: 64, height: 64, borderRadius: 16, background: p.accent, color: "#111", fontSize: 36, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</div>
            <div style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.25, color: p.text, paddingTop: 2 }}>
              {it.label}
              {it.detail ? <div style={{ fontSize: 34, fontWeight: 500, color: p.muted, marginTop: 6 }}>{it.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Quote: React.FC<ElProps & { reveal: number | undefined }> = ({ el, p, reveal }) => (
  <div style={{ borderLeft: `12px solid ${p.accent}`, paddingLeft: 40 }}>
    <div style={{ fontSize: 150, lineHeight: 0.6, color: p.accent, fontWeight: 900, height: 70 }}>“</div>
    <div style={{ fontSize: (el.text ?? "").length > 110 ? 50 : 62, fontWeight: 700, lineHeight: 1.25, color: p.text }}>
      <RichText text={el.text ?? ""} emphasis={el.emphasis} accent={p.accent} reveal={reveal} />
    </div>
    {el.label ? <div style={{ marginTop: 26, fontSize: 36, fontWeight: 600, color: p.muted }}>— {el.label}</div> : null}
  </div>
);

const Timeline: React.FC<ElProps & { local: number }> = ({ el, p, local }) => {
  const { fps } = useVideoConfig();
  const items = el.items ?? [];
  const step = Math.round(0.45 * fps);
  const line = interpolate(local, [0, step * Math.max(1, items.length)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "relative", paddingLeft: 70 }}>
      <div style={{ position: "absolute", left: 18, top: 10, width: 6, height: `${line * 100}%`, background: p.accent, borderRadius: 3 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
        {items.map((it, i) => {
          const q = spring({ frame: local - i * step, fps, config: { damping: 18, stiffness: 120 } });
          return (
            <div key={i} style={{ position: "relative", opacity: Math.min(1, q * 1.4), transform: `translateY(${(1 - q) * 30}px)` }}>
              <div style={{ position: "absolute", left: -66, top: 8, width: 34, height: 34, borderRadius: "50%", background: p.accent, boxShadow: `0 0 0 8px ${p.card}` }} />
              <div style={{ fontSize: 40, fontWeight: 900, color: p.accent }}>{it.label}</div>
              {it.detail ? <div style={{ fontSize: 42, fontWeight: 600, lineHeight: 1.25, color: p.text, marginTop: 4 }}>{it.detail}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Compare: React.FC<ElProps & { local: number }> = ({ el, p, language, local }) => {
  const { fps } = useVideoConfig();
  const [a, b] = el.items ?? [];
  const side = (it: MotionItem | undefined, i: number) => {
    if (!it) return null;
    const v = interpolate(local - i * Math.round(0.3 * fps), [0, Math.round(1.1 * fps)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
    return (
      <div style={{ flex: 1, background: p.card, borderRadius: 28, padding: "36px 28px", textAlign: "center", border: i === 1 ? `4px solid ${p.accent}` : `4px solid transparent` }}>
        <div style={{ fontSize: 36, fontWeight: 700, color: p.muted }}>{it.label}</div>
        {it.value != null ? (
          <div style={{ fontSize: 96, fontWeight: 900, color: i === 1 ? p.accent : p.text, marginTop: 12, fontVariantNumeric: "tabular-nums" }}>
            {el.prefix ?? ""}
            {formatMotionNumber(it.value * v, el.decimals ?? 0, language)}
            <span style={{ fontSize: 44 }}>{el.suffix ?? ""}</span>
          </div>
        ) : null}
        {it.detail ? <div style={{ fontSize: 34, fontWeight: 600, color: p.text, marginTop: 10, lineHeight: 1.25 }}>{it.detail}</div> : null}
      </div>
    );
  };
  return (
    <div style={{ display: "flex", gap: 28, alignItems: "stretch" }}>
      {side(a, 0)}
      {side(b, 1)}
    </div>
  );
};

const Icon: React.FC<ElProps & { local: number }> = ({ el, local }) => {
  const float = Math.sin(local / 18) * 10;
  return <div style={{ fontSize: 220, lineHeight: 1, alignSelf: "center", transform: `translateY(${float}px)` }}>{el.emoji ?? "📰"}</div>;
};

const Picture: React.FC<ElProps & { local: number }> = ({ el, p, images, local }) => {
  const src = el.image != null ? images[el.image] : undefined;
  if (!src) return null;
  const scale = interpolate(local, [0, 240], [1.04, 1.14], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div>
      <div style={{ height: 620, borderRadius: 32, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,.45)" }}>
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
      </div>
      {el.text ? <div style={{ marginTop: 18, fontSize: 36, fontWeight: 600, color: p.muted }}>{el.text}</div> : null}
    </div>
  );
};

const Element: React.FC<ElProps> = (props) => {
  const { el } = props;
  const { local, p } = useEnter(el.delay, el.enter === "pop" ? 12 : 18);
  const { fps } = useVideoConfig();
  const typing = el.enter === "type" ? interpolate(local, [0, Math.max(1, Math.round(((el.text ?? "").length / 28) * fps))], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : undefined;
  if (local < 0) return null;
  const inner = (() => {
    switch (el.type) {
      case "kicker":
        return <Kicker {...props} />;
      case "title":
        return <Title {...props} />;
      case "stat":
        return <Stat {...props} local={local} />;
      case "bars":
        return <Bars {...props} local={local} />;
      case "list":
        return <List {...props} local={local} />;
      case "quote":
        return <Quote {...props} reveal={typing} />;
      case "timeline":
        return <Timeline {...props} local={local} />;
      case "compare":
        return <Compare {...props} local={local} />;
      case "icon":
        return <Icon {...props} local={local} />;
      case "image":
        return <Picture {...props} local={local} />;
      default:
        return <Text {...props} reveal={typing} />;
    }
  })();
  // Titles and lists animate their own parts; the wrapper only fades those in.
  const own = el.type === "title" || el.type === "list" || el.type === "bars" || el.type === "timeline";
  return <div style={{ display: "flex", flexDirection: "column", ...(own ? { opacity: Math.min(1, p * 2) } : enterStyle(el.enter, p)) }}>{inner}</div>;
};

/* ------------------------------------------------------------------ beats */

const Beat: React.FC<{ beat: MotionBeat; durationFrames: number; area: ReturnType<typeof motionArea>; rest: Omit<ElProps, "el" | "width">; first: boolean; last: boolean }> = ({ beat, durationFrames, area, rest, first, last }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, BEAT_FADE, durationFrames - BEAT_FADE, durationFrames], [first ? 1 : 0, 1, 1, last ? 1 : 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lift = last ? 0 : interpolate(frame, [durationFrames - BEAT_FADE, durationFrames], [0, -40], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const width = area.x1 - area.x0;
  return (
    <AbsoluteFill style={{ opacity, transform: `translateY(${lift}px)` }}>
      <div style={{ position: "absolute", left: area.x0, top: area.y0, width, height: area.y1 - area.y0, display: "flex", flexDirection: "column", justifyContent: beat.align === "top" ? "flex-start" : "center", gap: 40, fontFamily: rest.font }}>
        {beat.elements.map((el, i) => (
          <Element key={i} el={el} width={width} {...rest} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const MotionVisual: React.FC<{ spec: MotionSpec; images: string[]; backdrop: Backdrop | null; durationFrames: number; brand: Brand; kind: TimelineScene["kind"]; language: "vi" | "en"; font: string }> = ({ spec: raw, images, backdrop, durationFrames, brand, kind, language, font }) => {
  const { fps } = useVideoConfig();
  const spec = normaliseMotionSpec(raw, durationFrames / fps);
  const p = palette(spec.mood, brand);
  const area = motionArea(brand, kind);
  const starts = spec.beats.map((b) => Math.min(durationFrames - 1, Math.round(b.at * fps)));
  return (
    <AbsoluteFill style={{ backgroundColor: p.bg, overflow: "hidden" }}>
      <Background spec={spec} p={p} images={images} backdrop={backdrop} />
      {spec.beats.map((beat, i) => {
        const from = starts[i];
        // A beat fades out in its last frames and the next one enters after it: never two layouts on screen at once.
        const end = i < spec.beats.length - 1 ? Math.max(from + 1, starts[i + 1]) : durationFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={Math.max(1, end - from)} name={`beat ${i + 1}`} layout="none">
            <Beat beat={beat} durationFrames={Math.max(1, end - from)} area={area} rest={{ p, font, language, images }} first={i === 0} last={i === spec.beats.length - 1} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
