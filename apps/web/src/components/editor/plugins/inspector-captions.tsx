"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sceneCaptions, setCaptionText } from "@/lib/media/editor";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { Section } from "../shell/ui";

function CaptionsTab() {
  const ctx = useEditor();
  const scene = ctx.selectedScene!;
  const captions = sceneCaptions(scene);
  const start = ctx.built.timings[ctx.selectedIndex]?.atSec ?? 0;
  return (
    <div className="space-y-3 text-sm">
      <Section
        title={`Phụ đề · ${captions.length} dòng`}
        aside={
          scene.captions ? (
            <Button size="xs" variant="ghost" disabled={ctx.readOnly} onClick={() => ctx.updateScene(scene.id, `${scene.id}: phụ đề tự động`, (s) => ({ ...s, captions: null }))}>
              theo giọng đọc
            </Button>
          ) : null
        }
      >
        <div className="space-y-1">
          {captions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <button type="button" className="w-12 shrink-0 rounded font-mono text-[11px] text-muted-foreground hover:text-primary" onClick={() => ctx.player.seek(start + c.startMs / 1000)} title="Tua tới dòng này">
                {(c.startMs / 1000).toFixed(1)}s
              </button>
              <Input
                value={c.text}
                disabled={ctx.readOnly}
                aria-label={`Dòng phụ đề ${i + 1}`}
                className="h-8 text-sm"
                onChange={(e) => ctx.updateScene(scene.id, `${scene.id}: sửa phụ đề`, (s) => ({ ...s, captions: sceneCaptions(s).map((x, j) => (j === i ? setCaptionText(x, e.target.value) : x)) }), { coalesce: `${scene.id}.caption.${i}` })}
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">Sửa chữ chỉ đổi phụ đề hiển thị; lời đọc giữ nguyên. Kiểu chữ theo bộ nhận diện.</p>
      </Section>
    </div>
  );
}

/** Inspector "Phụ đề": the scene's caption lines, editable in place, seek per line. */
export const captionsTabPlugin = definePlugin({
  id: "inspector.captions",
  name: "Phụ đề",
  description: "Sửa từng dòng phụ đề của cảnh, tua tới dòng, đặt lại theo giọng đọc.",
  inspector: [{ id: "captions", title: () => "Phụ đề", order: 30, when: (c) => Boolean(c.selectedScene?.voice), Component: CaptionsTab }],
});
