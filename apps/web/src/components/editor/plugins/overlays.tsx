"use client";
import { OUTPUT, SAFE_ZONES } from "@ai-news/video/schema";
import { sceneZones } from "@/lib/media/editor-checks";
import { useEditor, usePlayerTime } from "../core/context";
import { definePlugin } from "../core/plugin";

const W = OUTPUT.width;
const H = OUTPUT.height;

/** The platforms' UI (top bar, right rail, bottom caption / buttons) over the frame. */
function SafeZones() {
  const z = SAFE_ZONES;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
      <g fill="rgba(255,90,90,0.18)" stroke="rgba(255,130,130,0.9)" strokeDasharray="12 10" strokeWidth={3}>
        <rect x={0} y={0} width={W} height={z.top} />
        <rect x={W - z.right} y={z.top} width={z.right} height={H - z.top - z.bottom} />
        <rect x={0} y={H - z.bottom} width={W} height={z.bottom} />
      </g>
      <text x={24} y={H - z.bottom + 56} fill="rgba(255,200,200,0.95)" fontSize={40} fontFamily="system-ui">
        nút &amp; tên kênh của nền tảng
      </text>
    </svg>
  );
}

/** Where the scene under the playhead puts its headline, captions and credit: faces must stay clear of these. */
function TextZones() {
  const ctx = useEditor();
  const { frame } = usePlayerTime();
  const t = ctx.built.timings.findLast((x) => x.fromFrame <= frame) ?? ctx.built.timings[0];
  const scene = ctx.doc.scenes.find((s) => s.id === t?.id);
  if (!scene) return null;
  const zones = sceneZones(ctx.doc, scene, Boolean(ctx.doc.brand.logoSrc || ctx.props.previewLogo));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
      {zones.map((zone, i) => (
        <rect key={i} x={zone.x0} y={zone.y0} width={zone.x1 - zone.x0} height={zone.y1 - zone.y0} fill="rgba(56,189,248,0.12)" stroke="rgba(56,189,248,0.9)" strokeWidth={3} />
      ))}
    </svg>
  );
}

function Thirds() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
      <g stroke="rgba(255,255,255,0.45)" strokeWidth={2}>
        <line x1={W / 3} y1={0} x2={W / 3} y2={H} />
        <line x1={(2 * W) / 3} y1={0} x2={(2 * W) / 3} y2={H} />
        <line x1={0} y1={H / 3} x2={W} y2={H / 3} />
        <line x1={0} y1={(2 * H) / 3} x2={W} y2={(2 * H) / 3} />
      </g>
    </svg>
  );
}

/** Guides over the preview (never rendered into the video). */
export const overlaysPlugin = definePlugin({
  id: "preview.overlays",
  name: "Lớp hướng dẫn trên xem trước",
  description: "Vùng giao diện của nền tảng, vùng chữ của cảnh (khuôn mặt nên tránh) và lưới 1/3 trên khung xem trước.",
  overlays: [
    { id: "safe", label: "Vùng an toàn", order: 10, defaultOn: false, Component: SafeZones },
    { id: "text", label: "Vùng chữ", order: 20, defaultOn: false, Component: TextZones },
    { id: "thirds", label: "Lưới 1/3", order: 30, defaultOn: false, Component: Thirds },
  ],
});
