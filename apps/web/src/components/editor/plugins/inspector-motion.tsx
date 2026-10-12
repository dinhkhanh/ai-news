"use client";
import { sceneShots, setShot } from "@/lib/media/editor";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { MotionPanel } from "../motion-panel";

function MotionTab() {
  const ctx = useEditor();
  const scene = ctx.selectedScene!;
  const shots = sceneShots(scene);
  const active = ctx.selection.shot;
  return (
    <MotionPanel
      key={`${scene.id}-${active}`}
      scene={scene}
      shot={shots[active]}
      active={active}
      shotCount={shots.length}
      disabled={ctx.readOnly}
      canRegenerate={ctx.canRegenerate}
      defaultEngine={ctx.props.motionEngine}
      onEdit={(v) => ctx.updateScene(scene.id, `${scene.id}: chỉnh đồ hoạ`, (s) => setShot(s, active, v), { coalesce: `${scene.id}.motion.${active}` })}
      onGenerate={(payload) => ctx.services.regenerate("motion", { sceneId: scene.id, ...payload })}
    />
  );
}

/** Inspector "Đồ hoạ": Claude designs a motion graphic for the selected shot or the whole scene. */
export const motionTabPlugin = definePlugin({
  id: "inspector.motion",
  name: "Đồ hoạ chuyển động",
  description: "Claude dựng đồ hoạ chuyển động (Remotion / HyperFrames) cho hình đang chọn hoặc cả cảnh; sửa chữ của đồ hoạ.",
  inspector: [{ id: "motion", title: () => "Đồ hoạ", order: 40, Component: MotionTab }],
});
