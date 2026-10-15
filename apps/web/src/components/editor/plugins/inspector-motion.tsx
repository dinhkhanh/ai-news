"use client";
import { useMemo } from "react";
import { backdropOf, sceneShots, setShot, type EditorBackdrop } from "@/lib/media/editor";
import { sceneZones } from "@/lib/media/editor-checks";
import { frameStill } from "@/lib/media/framing";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { MotionPanel } from "../motion-panel";

/** At most this many library assets are offered as backdrops after the scene's own. */
const LIBRARY_MAX = 40;

function MotionTab() {
  const ctx = useEditor();
  const scene = ctx.selectedScene!;
  const shots = sceneShots(scene);
  const active = ctx.selection.shot;
  const hasLogo = Boolean(ctx.doc.brand.logoSrc || ctx.props.previewLogo);
  // The project's media library as backdrops: this scene's assets first; a picture is cropped on its faces under this scene's overlays, like a picture shot.
  const library = useMemo((): EditorBackdrop[] => {
    const zones = sceneZones(ctx.doc, scene, hasLogo);
    const ordered = [...ctx.media.options.filter((o) => o.sceneId === scene.id), ...ctx.media.options.filter((o) => o.sceneId !== scene.id)].slice(0, LIBRARY_MAX);
    return ordered.map((o) =>
      o.kind === "video"
        ? backdropOf({ kind: "video", key: o.key, clipDurationSec: o.durationSec ?? 5, trimStartSec: 0, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl })
        : backdropOf({ kind: "image", key: o.key, kenBurns: true, focus: o.frame ? frameStill(o.frame, zones).focus : null, sketch: null, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl }),
    );
  }, [ctx.media.options, ctx.doc, scene, hasLogo]);
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
      library={library}
      onEdit={(v) => ctx.updateScene(scene.id, `${scene.id}: chỉnh đồ hoạ`, (s) => setShot(s, active, v), { coalesce: `${scene.id}.motion.${active}` })}
      onGenerate={(payload) => ctx.services.regenerate("motion", { sceneId: scene.id, ...payload })}
    />
  );
}

/** Inspector "Đồ hoạ": Claude designs a motion graphic for the selected shot or the whole scene; its backdrop (clip / picture) is swapped without redesigning. */
export const motionTabPlugin = definePlugin({
  id: "inspector.motion",
  name: "Đồ hoạ chuyển động",
  description: "Claude dựng đồ hoạ chuyển động (Remotion / HyperFrames) cho hình đang chọn hoặc cả cảnh; sửa chữ của đồ hoạ; đổi video / ảnh nền mà giữ nguyên chuyển động.",
  inspector: [{ id: "motion", title: () => "Đồ hoạ", order: 40, Component: MotionTab }],
});
