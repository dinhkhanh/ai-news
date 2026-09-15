import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/BeVietnamPro";
import { OUTPUT, SAFE_ZONES, type TestCardProps } from "../schema";

const { fontFamily } = loadFont("normal", { weights: ["500", "700"], subsets: ["latin", "vietnamese"] });

/**
 * Phase 1 acceptance composition: exercises Vietnamese glyphs, safe zones,
 * a spring animation, a moving element (catches dropped frames / black frames)
 * and an audio track (catches loudness/AAC issues in the QA probe).
 */
export const TestCard: React.FC<TestCardProps> = ({ title }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const hue = interpolate(frame, [0, durationInFrames], [200, 320]);
  const x = interpolate(frame, [0, durationInFrames], [SAFE_ZONES.left, width - SAFE_ZONES.right - 160]);
  const seconds = (frame / fps).toFixed(2);

  return (
    <AbsoluteFill style={{ backgroundColor: `hsl(${hue} 60% 18%)`, fontFamily, color: "white" }}>
      <Audio src={staticFile("tone-1k.wav")} volume={0.5} />
      {/* safe-zone guides */}
      <div style={{ position: "absolute", inset: `${SAFE_ZONES.top}px ${SAFE_ZONES.right}px ${SAFE_ZONES.bottom}px ${SAFE_ZONES.left}px`, border: "2px dashed rgba(255,255,255,.35)" }} />
      <div style={{ position: "absolute", top: SAFE_ZONES.top + 40, left: SAFE_ZONES.left + 20, right: SAFE_ZONES.right + 20, transform: `translateY(${(1 - enter) * 40}px)`, opacity: enter }}>
        <div style={{ fontSize: 44, fontWeight: 500, opacity: 0.8 }}>ai-news · kiểm tra kết xuất</div>
        <div style={{ fontSize: 84, fontWeight: 700, lineHeight: 1.15, marginTop: 24 }}>{title}</div>
        <div style={{ fontSize: 40, marginTop: 32, lineHeight: 1.5 }}>Tiếng Việt có dấu: ắ ằ ẳ ẵ ặ — ế ề ể ễ ệ — ố ồ ổ ỗ ộ — ứ ừ ử ữ ự — đ Đ</div>
      </div>
      <div style={{ position: "absolute", top: height / 2, left: x, width: 160, height: 160, borderRadius: 32, background: "white", opacity: 0.9 }} />
      <div style={{ position: "absolute", bottom: SAFE_ZONES.bottom + 20, left: SAFE_ZONES.left + 20, fontSize: 36, fontVariantNumeric: "tabular-nums" }}>
        {OUTPUT.width}×{OUTPUT.height} @ {fps} fps · frame {frame} · {seconds}s
      </div>
    </AbsoluteFill>
  );
};
