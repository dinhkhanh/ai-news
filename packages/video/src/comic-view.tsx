import type { ComponentType, CSSProperties } from "react";
import { BALLOON_LINE_HEIGHT, COMIC_FONTS, pageGeometry, type Balloon, type ComicDoc, type ComicPage, type Panel } from "./comic";

/**
 * One comic page (docs/COMIC.md §3, §9). The same component draws the page in the app (reader, editor) and in a
 * `renderStillOnLambda` export, so what is exported is what was seen. Everything is laid out in percentages of the
 * page and `cqw` units, so the page scales with its container without JavaScript.
 */

type Img = ComponentType<{ src: string; alt: string; style?: CSSProperties }>;

export type ComicPageViewProps = {
  format: ComicDoc["format"];
  font: ComicDoc["font"];
  page: ComicPage;
  /** R2 key → URL (presigned) for every picture on the page. */
  srcs: Record<string, string>;
  /** Text in the bottom margin of the last page ("Minh hoạ bởi AI (Gemini)"). */
  credit?: string | null;
  /** In the app: a panel without a picture shows what it will be; in an export it stays white. */
  placeholders?: boolean;
  ImageComponent?: Img | "img";
  /** CSS font-family per lettering font, when the host loads the faces under other names (next/font). */
  families?: Partial<Record<ComicDoc["font"], string>>;
};

const pct = (n: number, of: number) => `${(n / of) * 100}%`;
const cqw = (px: number, width: number) => `${((px / width) * 100).toFixed(4)}cqw`;

function PanelBox({ panel, width, height, srcs, placeholders, ImageComponent }: { panel: Panel; width: number; height: number; srcs: Record<string, string>; placeholders: boolean; ImageComponent: Img | "img" }) {
  const { border } = pageGeometry({ width });
  const src = panel.image ? srcs[panel.image.key] : undefined;
  const style: CSSProperties = {
    position: "absolute",
    left: pct(panel.rect.x, width),
    top: pct(panel.rect.y, height),
    width: pct(panel.rect.w, width),
    height: pct(panel.rect.h, height),
    boxSizing: "border-box",
    border: `${cqw(border, width)} solid #111113`,
    overflow: "hidden",
    background: src || !placeholders ? "#FFFFFF" : "repeating-linear-gradient(45deg, #F1F1F3 0 2px, #FAFAFA 2px 14px)",
  };
  const Tag = ImageComponent;
  return (
    <div style={style}>
      {src ? <Tag src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : null}
      {!src && placeholders ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", padding: cqw(14, width), boxSizing: "border-box" }}>
          <span style={{ fontFamily: "'Be Vietnam Pro', system-ui, sans-serif", fontSize: cqw(15, width), lineHeight: 1.35, color: panel.error ? "#B91C1C" : "#52525B" }}>
            {panel.error ? `Lỗi khi vẽ: ${panel.error}` : panel.script.description}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Geometry of a balloon's tail: the base sits just inside the balloon edge, on the ray from its centre to the tip. */
export function tailGeometry(b: Balloon) {
  if (!b.rect || !b.tail) return null;
  const cx = b.rect.x + b.rect.w / 2;
  const cy = b.rect.y + b.rect.h / 2;
  const dx = b.tail.x - cx;
  const dy = b.tail.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Distance from the centre to the edge of the box along the ray (ellipse for rounded balloons is close enough).
  const exit = Math.min(Math.abs(ux) > 1e-6 ? b.rect.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? b.rect.h / 2 / Math.abs(uy) : Infinity);
  if (len <= exit) return null;
  const inset = b.fontSize * 0.5;
  const bx = cx + ux * (exit - inset);
  const by = cy + uy * (exit - inset);
  const hw = Math.min(b.fontSize * 0.55, b.rect.w * 0.14);
  const px = -uy * hw;
  const py = ux * hw;
  return { base: [bx + px, by + py, bx - px, by - py] as const, tip: [b.tail.x, b.tail.y] as const, centre: [cx, cy] as const, ux, uy, exit };
}

function balloonStyle(b: Balloon, width: number, height: number, family: string): CSSProperties {
  const r = b.rect!;
  const base: CSSProperties = {
    position: "absolute",
    left: pct(r.x, width),
    top: pct(r.y, height),
    width: pct(r.w, width),
    height: pct(r.h, height),
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    fontFamily: `${family}, 'Be Vietnam Pro', system-ui, sans-serif`,
    fontSize: cqw(b.fontSize, width),
    lineHeight: BALLOON_LINE_HEIGHT,
    color: "#111113",
    overflowWrap: "break-word",
    padding: `0 ${cqw(b.fontSize * 0.5, width)}`,
  };
  const line = cqw(Math.max(2, b.fontSize * 0.09), width);
  switch (b.kind) {
    case "caption":
      return { ...base, background: "#FFF4C2", border: `${line} solid #111113`, textAlign: "left", justifyContent: "flex-start" };
    case "thought":
      return { ...base, background: "#FFFFFF", border: `${line} solid #111113`, borderRadius: "50%" };
    case "whisper":
      return { ...base, background: "#FFFFFF", border: `${line} dashed #111113`, borderRadius: "999px", fontStyle: "italic" };
    case "shout":
      return { ...base, background: "#FFFFFF", border: `${cqw(Math.max(3, b.fontSize * 0.16), width)} solid #111113`, borderRadius: cqw(b.fontSize * 0.4, width), fontWeight: 700 };
    case "sfx":
      return {
        ...base,
        padding: 0,
        color: "#C81E1E",
        fontWeight: 700,
        transform: "rotate(-7deg)",
        textShadow: ["-1px -1px", "1px -1px", "-1px 1px", "1px 1px", "0 2px", "2px 0", "0 -2px", "-2px 0"].map((o) => `${o} 0 #FFFFFF`).join(", "),
      };
    default:
      return { ...base, background: "#FFFFFF", border: `${line} solid #111113`, borderRadius: "999px" };
  }
}

export function ComicPageView({ format, font, page, srcs, credit, placeholders = false, ImageComponent = "img", families }: ComicPageViewProps) {
  const width = format.width;
  const height = page.height;
  const family = families?.[font] ?? `'${COMIC_FONTS[font]?.family ?? "Itim"}'`;
  const balloons = page.panels.flatMap((p) => p.lettering).filter((b) => b.rect && b.text.trim());
  const tails = balloons.filter((b) => b.kind !== "caption" && b.kind !== "sfx").map((b) => ({ b, g: tailGeometry(b) }));
  const stroke = (b: Balloon) => Math.max(2, b.fontSize * (b.kind === "shout" ? 0.16 : 0.09));
  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: `${width} / ${height}`, containerType: "inline-size", background: "#FFFFFF", overflow: "hidden" }}>
      {page.panels.map((p) => (
        <PanelBox key={p.id} panel={p} width={width} height={height} srcs={srcs} placeholders={placeholders} ImageComponent={ImageComponent} />
      ))}
      {/* Tails under the balloons: the outline… */}
      <svg viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} aria-hidden>
        {tails.map(({ b, g }) =>
          g && b.kind !== "thought" ? (
            <polygon key={b.id} points={`${g.base[0]},${g.base[1]} ${g.tip[0]},${g.tip[1]} ${g.base[2]},${g.base[3]}`} fill="#FFFFFF" stroke="#111113" strokeWidth={stroke(b) * 2} strokeLinejoin="round" strokeDasharray={b.kind === "whisper" ? `${b.fontSize * 0.3} ${b.fontSize * 0.2}` : undefined} />
          ) : null,
        )}
      </svg>
      {balloons.map((b) => (
        <div key={b.id} style={balloonStyle(b, width, height, family)}>
          <span style={{ whiteSpace: "pre-line" }}>{b.text}</span>
        </div>
      ))}
      {/* …and their fill over the balloon's border, so the tail joins the balloon; thought balloons trail bubbles. */}
      <svg viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} aria-hidden>
        {tails.map(({ b, g }) => {
          if (!g) return null;
          if (b.kind === "thought") {
            const steps = [0.35, 0.65, 0.92];
            const startX = g.centre[0] + g.ux * g.exit;
            const startY = g.centre[1] + g.uy * g.exit;
            return (
              <g key={b.id}>
                {steps.map((s, i) => (
                  <circle key={i} cx={startX + (g.tip[0] - startX) * s} cy={startY + (g.tip[1] - startY) * s} r={b.fontSize * (0.42 - i * 0.12)} fill="#FFFFFF" stroke="#111113" strokeWidth={stroke(b)} />
                ))}
              </g>
            );
          }
          const k = 0.86;
          const mx = (g.base[0] + g.base[2]) / 2;
          const my = (g.base[1] + g.base[3]) / 2;
          const shrink = (x: number, y: number) => `${mx + (x - mx) * k},${my + (y - my) * k}`;
          const tipX = mx + (g.tip[0] - mx) * 0.9;
          const tipY = my + (g.tip[1] - my) * 0.9;
          return <polygon key={b.id} points={`${shrink(g.base[0], g.base[1])} ${tipX},${tipY} ${shrink(g.base[2], g.base[3])}`} fill="#FFFFFF" />;
        })}
      </svg>
      {credit ? (
        <span style={{ position: "absolute", right: pct(pageGeometry({ width }).margin, width), bottom: cqw(pageGeometry({ width }).margin * 0.25, width), fontFamily: "'Be Vietnam Pro', system-ui, sans-serif", fontSize: cqw(14, width), color: "#52525B" }}>{credit}</span>
      ) : null}
    </div>
  );
}
