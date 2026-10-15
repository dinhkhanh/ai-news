"use client";
import { useState } from "react";
import type { MotionElement, MotionEngine, MotionSpec } from "@ai-news/video/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { backdropCandidates, backdropId, backdropOf, type EditorBackdrop, type EditorScene, type EditorVisual } from "@/lib/media/editor";

export const MOTION_ENGINE_LABEL: Record<MotionEngine, string> = {
  remotion: "Remotion · mẫu đồ hoạ theo thương hiệu",
  hyperframes: "HyperFrames · HTML + GSAP tự do",
};

const ELEMENT_LABEL: Record<MotionElement["type"], string> = {
  kicker: "nhãn",
  title: "tiêu đề",
  text: "chữ",
  stat: "con số",
  bars: "biểu đồ cột",
  list: "danh sách",
  quote: "trích dẫn",
  timeline: "mốc thời gian",
  compare: "so sánh",
  icon: "biểu tượng",
  image: "ảnh",
};

type Props = {
  scene: EditorScene;
  shot: EditorVisual;
  active: number;
  shotCount: number;
  disabled: boolean;
  canRegenerate: boolean;
  defaultEngine: MotionEngine;
  /** The project's media library as backdrops (this scene's assets first), offered after the scene's own clips and pictures. */
  library: EditorBackdrop[];
  /** Replace the active shot (inline edits of a generated graphic). */
  onEdit: (visual: EditorVisual) => void;
  onGenerate: (payload: { engine: MotionEngine; instruction?: string; shot: number | null; backdrop: { kind: "video" | "image"; key: string; trimStartSec: number } | null }) => void;
};

const idOf = (b: EditorBackdrop | null) => (b ? backdropId(b) : "");
const backdropLabel = (b: EditorBackdrop, n: number) =>
  b.kind === "video" ? `Clip ${n} · ${b.clipDurationSec.toFixed(0)} s${b.trimStartSec ? ` từ ${b.trimStartSec.toFixed(0)} s` : ""}${b.credit ? ` · ${b.credit}` : ""}` : `Ảnh ${n}${b.credit ? ` · ${b.credit}` : ""}`;

/**
 * "Đồ hoạ chuyển động" in the inspector: Claude Opus 5.5 designs a motion
 * graphic from the scene's voice-over and word timings, for the active shot
 * or for the whole scene (one graphic replacing every shot), with either
 * engine (`@ai-news/video/motion`). Runs in the background like the other
 * regenerations (a new version). A generated spec's words can be fixed here
 * without another call; a HyperFrames shot shows its HTML. "Nền" picks a
 * clip or picture to show behind the graphic (dimmed): the scene's own first,
 * then the project's media library; preselected when the shot is a clip or
 * picture, passed to the next design, and on a graphic that already exists
 * swapped in place, so only the background changes and the motion stays.
 */
export function MotionPanel({ scene, shot, active, shotCount, disabled, canRegenerate, defaultEngine, library, onEdit, onGenerate }: Props) {
  const [engine, setEngine] = useState<MotionEngine>(shot.kind === "hyperframes" ? "hyperframes" : shot.kind === "motion" ? "remotion" : defaultEngine);
  const [instruction, setInstruction] = useState("");
  const graphic = shot.kind === "motion" || shot.kind === "hyperframes";
  const own = backdropCandidates(scene);
  const more = library.filter((b) => !own.some((o) => backdropId(o) === backdropId(b)));
  const all = [...own, ...more];
  const [clipId, setClipId] = useState(idOf(shot.kind === "video" || shot.kind === "image" ? backdropOf(shot) : graphic ? shot.backdrop : null));
  const clip = all.find((c) => backdropId(c) === clipId) ?? null;
  const payload = (whole: boolean) => ({ engine, instruction: instruction.trim() || undefined, shot: whole ? null : active, backdrop: clip ? { kind: clip.kind, key: clip.key, trimStartSec: clip.kind === "video" ? clip.trimStartSec : 0 } : null });
  const pickClip = (id: string) => {
    setClipId(id);
    if (!graphic) return;
    const next = all.find((c) => backdropId(c) === id) ?? null;
    // An existing graphic takes the backdrop right away, its motion untouched; a Remotion spec switches its background to the backdrop and back.
    if (shot.kind === "motion") onEdit({ ...shot, backdrop: next, spec: { ...shot.spec, background: next ? "video" : shot.spec.background === "video" ? "gradient" : shot.spec.background } });
    else onEdit({ ...shot, backdrop: next });
  };
  const options = (list: EditorBackdrop[], offset: number) =>
    list.map((c, i) => (
      <option key={backdropId(c)} value={backdropId(c)}>
        {backdropLabel(c, offset + i + 1)}
      </option>
    ));

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Đồ hoạ chuyển động (Claude Opus 5.5)</Label>
        <NativeSelect fieldSize="sm" value={engine} onChange={(e) => setEngine(e.target.value as MotionEngine)} disabled={!canRegenerate} className="max-w-64" aria-label="Công cụ dựng đồ hoạ">
          {(Object.keys(MOTION_ENGINE_LABEL) as MotionEngine[]).map((k) => (
            <option key={k} value={k}>
              {MOTION_ENGINE_LABEL[k]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Textarea
        rows={2}
        value={instruction}
        maxLength={1000}
        disabled={!canRegenerate}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Gợi ý (tuỳ chọn): “biểu đồ so sánh 2 năm”, “chữ to từng từ theo lời đọc”, “tông đỏ khẩn cấp”…"
        className="text-sm"
      />
      {all.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="motion-backdrop" className="text-xs">
            Nền (video / ảnh)
          </Label>
          <NativeSelect id="motion-backdrop" fieldSize="sm" value={clipId} onChange={(e) => pickClip(e.target.value)} disabled={graphic ? disabled : !canRegenerate} className="max-w-64">
            <option value="">Không – nền vẽ</option>
            {more.length ? (
              <>
                <optgroup label="Trong cảnh">{options(own, 0)}</optgroup>
                <optgroup label="Thư viện dự án">{options(more, own.length)}</optgroup>
              </>
            ) : (
              options(own, 0)
            )}
          </NativeSelect>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!canRegenerate} onClick={() => onGenerate(payload(false))}>
          {shot.kind === "motion" || shot.kind === "hyperframes" ? `Tạo lại đồ hoạ cảnh quay ${active + 1}` : `Thay cảnh quay ${active + 1} bằng đồ hoạ`}
        </Button>
        {shotCount > 1 || !(shot.kind === "motion" || shot.kind === "hyperframes") ? (
          <Button type="button" size="sm" variant="ghost" disabled={!canRegenerate} onClick={() => onGenerate(payload(true))}>
            Cả cảnh {scene.id} là một đồ hoạ
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Chỉ dùng dữ kiện trong lời đọc của cảnh; chạy nền ~1 phút, thành phiên bản mới. Phụ đề vẫn hiện bên dưới đồ hoạ.
        {all.length ? (graphic ? " Đổi nền áp dụng ngay và giữ nguyên chuyển động của đồ hoạ; nền hiện mờ phía sau (với HyperFrames, sân khấu được làm trong suốt, lớp phủ kín khung do mã vẽ vẫn che)." : " Nền hiện mờ phía sau đồ hoạ sẽ dựng.") : ""}
      </p>

      {shot.kind === "motion" ? <SpecTexts spec={shot.spec} disabled={disabled} onChange={(spec) => onEdit({ ...shot, spec })} /> : null}
      {shot.kind === "hyperframes" ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{shot.summary ?? "Mã HyperFrames"} · sửa HTML</summary>
          <Textarea rows={10} value={shot.html} disabled={disabled} onChange={(e) => onEdit({ ...shot, html: e.target.value })} className="mt-2 font-mono text-[11px]" spellCheck={false} />
        </details>
      ) : null}
    </div>
  );
}

/** The words of a generated spec, editable in place (typos, names); the layout and timing stay. */
function SpecTexts({ spec, disabled, onChange }: { spec: MotionSpec; disabled: boolean; onChange: (spec: MotionSpec) => void }) {
  const setEl = (b: number, e: number, patch: Partial<MotionElement>) =>
    onChange({ ...spec, beats: spec.beats.map((beat, i) => (i !== b ? beat : { ...beat, elements: beat.elements.map((el, j) => (j === e ? { ...el, ...patch } : el)) })) });
  return (
    <div className="space-y-2">
      {spec.beats.map((beat, b) => (
        <div key={b} className="space-y-1 rounded-md bg-muted/40 p-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            Nhịp {b + 1} · từ {beat.at.toFixed(1)} s
          </div>
          {beat.elements.map((el, e) => (
            <div key={e} className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{ELEMENT_LABEL[el.type]}</span>
              {el.label != null ? <Input value={el.label} disabled={disabled} onChange={(ev) => setEl(b, e, { label: ev.target.value })} className="h-7 min-w-0 flex-1 text-xs" /> : null}
              {el.text != null ? <Input value={el.text} disabled={disabled} onChange={(ev) => setEl(b, e, { text: ev.target.value })} className="h-7 min-w-0 flex-[2] text-xs" /> : null}
              {el.value != null ? <Input type="number" value={el.value} disabled={disabled} onChange={(ev) => setEl(b, e, { value: Number(ev.target.value) || 0 })} className="h-7 w-28 text-xs" /> : null}
              {el.items?.map((it, k) => (
                <Input
                  key={k}
                  value={it.label}
                  disabled={disabled}
                  onChange={(ev) => setEl(b, e, { items: el.items!.map((x, m) => (m === k ? { ...x, label: ev.target.value } : x)) })}
                  className="h-7 w-36 text-xs"
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
