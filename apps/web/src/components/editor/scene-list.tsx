"use client";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SceneVerdict } from "@/lib/llm/schemas";
import type { EditorScene } from "@/lib/media/editor";
import { cn } from "@/lib/utils";

export type SceneListProps = {
  scenes: EditorScene[];
  timings: Array<{ id: string; atSec: number; durationMs: number }>;
  selectedId: string | null;
  verdicts: Record<string, { verdict: SceneVerdict["verdict"] }> | null;
  thumb: (scene: EditorScene) => { url: string | null; video: boolean };
  disabled: boolean;
  onSelect: (id: string) => void;
  onReorder: (scenes: EditorScene[]) => void;
};

const verdictVariant = (v?: SceneVerdict["verdict"]) =>
  v === "supported" ? "default" : v === "partial" ? "secondary" : v === "unsupported" ? "destructive" : "outline";
const verdictLabel = (v?: SceneVerdict["verdict"]) =>
  v === "supported" ? "căn cứ" : v === "partial" ? "một phần" : v === "unsupported" ? "không căn cứ" : "chưa kiểm";

function SceneCard({
  scene,
  index,
  timing,
  selected,
  verdict,
  thumb,
  disabled,
  onSelect,
}: {
  scene: EditorScene;
  index: number;
  timing?: { atSec: number; durationMs: number };
  selected: boolean;
  verdict?: SceneVerdict["verdict"];
  thumb: { url: string | null; video: boolean };
  disabled: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: scene.id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer gap-2 rounded-md border bg-background p-2 text-sm transition-colors hover:bg-muted/50",
        selected && "border-primary bg-muted/60",
        isDragging && "opacity-60 shadow-lg",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label="Kéo để đổi thứ tự"
        className={cn(
          "flex w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing",
          disabled && "cursor-not-allowed opacity-40",
        )}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="h-20 w-[45px] shrink-0 overflow-hidden rounded bg-muted">
        {thumb.url ? (
          thumb.video ? (
            <video src={thumb.url} muted preload="metadata" className="h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb.url} alt="" className="h-full w-full object-cover" loading="lazy" />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">màu</div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="font-mono">{index + 1}</span>
          <Badge variant="outline">{scene.id}</Badge>
          <Badge variant="secondary">{scene.kind}</Badge>
          {timing ? (
            <span>
              {timing.atSec.toFixed(1)} s · {(timing.durationMs / 1000).toFixed(1)} s
            </span>
          ) : null}
          {verdict !== undefined || scene.kind === "body" ? (
            <Badge variant={verdictVariant(verdict)} className="ml-auto">
              {verdictLabel(verdict)}
            </Badge>
          ) : null}
        </div>
        <div className="truncate font-medium">
          {scene.onScreenText || <span className="text-muted-foreground">(không chữ)</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{scene.voiceover}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {scene.visual.kind === "video"
            ? `Clip${scene.visual.trimStartSec ? ` từ ${scene.visual.trimStartSec.toFixed(1)} s` : ""} · ${scene.visual.credit ?? ""}`
            : scene.visual.kind === "image"
              ? `Ảnh · ${scene.visual.credit ?? ""}`
              : "Nền màu thương hiệu"}
          {scene.holdMs ? ` · giữ +${scene.holdMs} ms` : ""}
          {scene.captions ? " · phụ đề đã sửa" : ""}
        </div>
      </div>
    </div>
  );
}

/** Vertical scene track: drag to reorder (pointer or keyboard), click to inspect. */
export function SceneList({
  scenes,
  timings,
  selectedId,
  verdicts,
  thumb,
  disabled,
  onSelect,
  onReorder,
}: SceneListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = scenes.findIndex((s) => s.id === active.id);
    const to = scenes.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(scenes, from, to));
  };
  const timingById = new Map(timings.map((t) => [t.id, t]));
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={scenes.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {scenes.map((s, i) => (
            <SceneCard
              key={s.id}
              scene={s}
              index={i}
              timing={timingById.get(s.id)}
              selected={s.id === selectedId}
              verdict={verdicts?.[s.id]?.verdict}
              thumb={thumb(s)}
              disabled={disabled}
              onSelect={() => onSelect(s.id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
