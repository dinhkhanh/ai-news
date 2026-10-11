import { MOTION_ENGINES, MOTION_MODES, type MotionEngine, type MotionMode } from "@ai-news/video/motion";
import { NativeSelect } from "@/components/ui/native-select";

const MODE_LABEL: Record<MotionMode, string> = {
  off: "Không dùng đồ hoạ",
  auto: "Claude chọn cảnh hợp (số liệu, mốc thời gian…)",
  all: "Toàn bộ video là đồ hoạ chuyển động",
};
const ENGINE_LABEL: Record<MotionEngine, string> = {
  remotion: "Remotion (mẫu theo bộ nhận diện)",
  hyperframes: "HyperFrames (HTML + GSAP tự do)",
};

/**
 * "Đồ hoạ chuyển động" of the new-project and build forms (`motionMode` + `motionEngine`): Claude Opus 5.5 designs
 * motion graphics from the script for some scenes or for the whole video, drawn by Remotion or HyperFrames.
 */
export function MotionSelect({ idPrefix, mode, engine, size, className }: { idPrefix: string; mode: MotionMode; engine: MotionEngine; size?: "sm"; className?: string }) {
  return (
    <div className={className ?? "flex flex-wrap gap-2"}>
      <NativeSelect id={`${idPrefix}-mode`} name="motionMode" defaultValue={mode} fieldSize={size} className="min-w-0 flex-1" title="Claude Opus 5.5 dựng đồ hoạ chuyển động từ kịch bản, khớp với lời đọc. Cảnh là đồ hoạ thì không tìm ảnh / clip.">
        {MOTION_MODES.map((m) => (
          <option key={m} value={m}>
            {MODE_LABEL[m]}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect id={`${idPrefix}-engine`} name="motionEngine" defaultValue={engine} fieldSize={size} className="min-w-0 flex-1" title="Remotion: mẫu đồ hoạ có sẵn (tiêu đề động, con số, biểu đồ, danh sách, mốc thời gian…) theo màu thương hiệu. HyperFrames: Claude viết HTML + GSAP tự do, sáng tạo hơn nhưng khó đoán hơn.">
        {MOTION_ENGINES.map((e) => (
          <option key={e} value={e}>
            {ENGINE_LABEL[e]}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** Form values → a valid mode / engine (unknown values fall back to `fallback`). */
export function parseMotion(fd: FormData, fallback: { mode: MotionMode; engine: MotionEngine }) {
  const m = String(fd.get("motionMode") ?? "");
  const e = String(fd.get("motionEngine") ?? "");
  return {
    mode: (MOTION_MODES as readonly string[]).includes(m) ? (m as MotionMode) : fallback.mode,
    engine: (MOTION_ENGINES as readonly string[]).includes(e) ? (e as MotionEngine) : fallback.engine,
  };
}
