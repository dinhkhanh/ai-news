"use client";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Layers } from "lucide-react";
import { sceneShots, sceneVoiceMs, type EditorScene } from "@/lib/media/editor";
import { cn } from "@/lib/utils";
import { useEditor, type EditorCtx } from "../core/context";
import { definePlugin, type TimelineLayout } from "../core/plugin";
import { fmtSec, PanelHeader, SEVERITY_DOT, Thumb } from "../shell/ui";

const KIND_STYLE = {
  hook: { chip: "bg-primary/15 text-primary", block: "border-primary/50 bg-primary/10" },
  body: { chip: "bg-muted text-muted-foreground", block: "border-border bg-muted/60" },
  cta: { chip: "bg-success/15 text-success", block: "border-success/50 bg-success/10" },
} as const;

function SceneRow({ scene, index }: { scene: EditorScene; index: number }) {
  const ctx = useEditor();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: scene.id, disabled: ctx.readOnly });
  const selected = ctx.selection.sceneId === scene.id;
  const first = sceneShots(scene)[0];
  const t = ctx.derived.thumb(first);
  const issue = ctx.derived.issues.find((i) => i.sceneId === scene.id && i.severity !== "info");
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn(isDragging && "relative z-10 opacity-70")}>
      <div className={cn("flex items-center gap-2 rounded-lg border border-transparent p-1.5 hover:bg-muted/60", selected && "border-primary/40 bg-primary/5")}>
        <button ref={setActivatorNodeRef} type="button" aria-label={`Kéo để đổi thứ tự cảnh ${scene.id}`} className={cn("flex h-14 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing", ctx.readOnly && "cursor-not-allowed opacity-40")} {...attributes} {...listeners}>
          <GripVertical className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            ctx.select({ sceneId: scene.id });
            ctx.player.seekScene(scene.id);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-current={selected}
        >
          <span className="relative h-16 w-9 shrink-0 overflow-hidden rounded-md bg-muted">
            <Thumb src={t.src} video={t.video} />
            <span className="absolute right-0 bottom-0 left-0 bg-black/60 text-center text-[9px] text-white">{sceneShots(scene).length}</span>
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className="font-mono text-muted-foreground">{index + 1}</span>
              <span className="font-mono">{scene.id}</span>
              <span className={cn("rounded px-1 text-[10px] font-semibold uppercase", KIND_STYLE[scene.kind].chip)}>{scene.kind}</span>
              <span className="ml-auto font-mono text-muted-foreground">{fmtSec(sceneVoiceMs(scene) / 1000)}</span>
            </span>
            <span className="line-clamp-2 text-[13px] leading-snug">{scene.onScreenText || <span className="text-muted-foreground">{scene.voiceover.slice(0, 80)}</span>}</span>
            {issue ? (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", SEVERITY_DOT[issue.severity])} />
                <span className="truncate">{issue.title}</span>
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
}

function ScenesPanel() {
  const ctx = useEditor();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const scenes = ctx.doc.scenes;
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = scenes.findIndex((s) => s.id === active.id);
    const to = scenes.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    ctx.update(`Chuyển ${active.id} tới vị trí ${to + 1}`, (d) => ({ ...d, scenes: arrayMove(d.scenes, from, to) }));
  };
  return (
    <div>
      <PanelHeader title="Cảnh" meta={`${scenes.length} · ${fmtSec(ctx.durationSec)}`} />
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">Kéo tay cầm để đổi thứ tự · bấm để sửa · [ ] chuyển cảnh</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={scenes.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="space-y-0.5 px-1.5 pb-3">
            {scenes.map((s, i) => (
              <SceneRow key={s.id} scene={s} index={i} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SceneTrack({ layout }: { layout: TimelineLayout }) {
  const ctx = useEditor();
  return (
    <>
      {ctx.built.timings.map((t, i) => {
        const scene = ctx.doc.scenes[i];
        const selected = ctx.selection.sceneId === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              ctx.select({ sceneId: t.id });
              ctx.player.seekScene(t.id);
            }}
            className={cn("absolute top-0 flex h-full flex-col justify-center overflow-hidden rounded-md border px-1.5 text-left", KIND_STYLE[scene.kind].block, selected && "border-2 border-primary")}
            style={{ left: layout.x(t.fromFrame / ctx.player.fps) + 1, width: Math.max(4, layout.x(t.durationFrames / ctx.player.fps) - 2) }}
            aria-label={`Cảnh ${t.id}`}
            aria-current={selected}
          >
            <span className="truncate text-[10px] font-semibold uppercase opacity-80">
              {t.id} · {scene.kind}
            </span>
            <span className="truncate text-[11px]">{scene.onScreenText}</span>
          </button>
        );
      })}
    </>
  );
}

const step = (d: number) => (c: EditorCtx) => {
  const next = c.doc.scenes[Math.min(c.doc.scenes.length - 1, Math.max(0, c.selectedIndex + d))];
  if (!next) return;
  c.select({ sceneId: next.id });
  c.player.seekScene(next.id);
};

/** The scene list (reorder, select), the scene row of the timeline and scene navigation. */
export const scenesPlugin = definePlugin({
  id: "scenes",
  name: "Cảnh",
  description: "Danh sách cảnh kéo thả để đổi thứ tự, hàng Cảnh trên dòng thời gian, phím [ ] chuyển cảnh.",
  required: true,
  panels: [{ id: "scenes", title: "Cảnh", icon: Layers, order: 10, Component: ScenesPanel }],
  tracks: [{ id: "scenes", label: "Cảnh", height: 40, order: 10, Component: SceneTrack }],
  commands: [
    { id: "scenes.prev", title: () => "Cảnh trước", group: "Cảnh", keys: "[", shortcut: { match: (e) => e.key === "[" }, run: step(-1) },
    { id: "scenes.next", title: () => "Cảnh sau", group: "Cảnh", keys: "]", shortcut: { match: (e) => e.key === "]" }, run: step(1) },
    {
      id: "scenes.remove",
      title: (c) => `Bỏ cảnh ${c.selectedScene?.id ?? ""}`,
      group: "Cảnh",
      when: (c) => !c.readOnly && c.doc.scenes.length > 1 && Boolean(c.selectedScene),
      run: (c) => {
        const id = c.selectedScene!.id;
        const next = c.doc.scenes[c.selectedIndex + 1] ?? c.doc.scenes[c.selectedIndex - 1];
        c.update(`Bỏ cảnh ${id}`, (d) => ({ ...d, scenes: d.scenes.filter((s) => s.id !== id) }));
        if (next) c.select({ sceneId: next.id });
      },
    },
  ],
});
