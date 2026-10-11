import { PHOTO_SKETCH_MODES, type PhotoSketch } from "@ai-news/video/schema";
import { NativeSelect } from "@/components/ui/native-select";

const SKETCH_MODE_LABEL: Record<PhotoSketch, string> = {
  off: "Giữ ảnh gốc",
  pencil: "Ảnh chuyển thành tranh bút chì",
  ink: "Ảnh chuyển thành tranh bút mực",
  colour: "Ảnh chuyển thành tranh bút màu",
};

/**
 * "Ảnh vẽ tay" of the new-project and build forms (`photoSketch`): every downloaded photo (article, other outlets,
 * stock) opens as the photo and turns into a hand-drawn version of itself, so the video transforms the pictures it
 * borrows (platforms' unoriginal-content rules). AI stills stay as they are; the editor sets it per shot.
 */
export function SketchSelect({ id, value, size, className }: { id: string; value: PhotoSketch; size?: "sm"; className?: string }) {
  return (
    <NativeSelect
      id={id}
      name="photoSketch"
      defaultValue={value}
      fieldSize={size}
      className={className}
      title="Mỗi ảnh tải về (bài gốc, báo khác, stock) mở đầu bằng ảnh thật rồi một nét bút quét qua, biến ảnh thành tranh vẽ tay của chính nó – video biến đổi hình đi mượn, không chỉ chiếu lại. Ảnh AI và clip giữ nguyên. Chỉnh từng ảnh trong trình biên tập."
    >
      {PHOTO_SKETCH_MODES.map((m) => (
        <option key={m} value={m}>
          {SKETCH_MODE_LABEL[m]}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Form value → a valid setting (unknown values fall back to `fallback`). */
export function parsePhotoSketch(fd: FormData, fallback: PhotoSketch): PhotoSketch {
  const v = String(fd.get("photoSketch") ?? "");
  return (PHOTO_SKETCH_MODES as readonly string[]).includes(v) ? (v as PhotoSketch) : fallback;
}
