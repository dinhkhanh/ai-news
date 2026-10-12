"use client";
import { ChevronDown, ChevronUp, Crosshair, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sceneVoiceMs } from "@/lib/media/editor";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { fmtSec } from "./ui";

const KIND_TONE = { hook: "default", body: "secondary", cta: "success" } as const;

/** The selected scene: header with navigation, then one tab per inspector plugin that applies. */
export function Inspector() {
  const ctx = useEditor();
  const scene = ctx.selectedScene;
  if (!scene) return <p className="p-4 text-sm text-muted-foreground">Chọn một cảnh.</p>;
  const tabs = ctx.plugins.contributions.inspector.filter((t) => !t.when || t.when(ctx));
  const active = tabs.find((t) => t.id === ctx.ui.tab) ?? tabs[0];
  const Body = active?.Component;
  const go = (d: number) => {
    const next = ctx.doc.scenes[ctx.selectedIndex + d];
    if (!next) return;
    ctx.select({ sceneId: next.id });
    ctx.player.seekScene(next.id);
  };
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-mono text-sm font-medium">{scene.id}</span>
        <Badge variant={KIND_TONE[scene.kind]} className="uppercase">
          {scene.kind}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {ctx.selectedIndex + 1}/{ctx.doc.scenes.length} · {fmtSec(sceneVoiceMs(scene) / 1000)}
        </span>
        <span className="ml-auto flex items-center">
          <Button variant="ghost" size="icon-xs" onClick={() => ctx.player.seekScene(scene.id)} aria-label="Tua tới cảnh" title="Tua tới cảnh">
            <Crosshair />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled={ctx.selectedIndex <= 0} onClick={() => go(-1)} aria-label="Cảnh trước" title="Cảnh trước ([)">
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled={ctx.selectedIndex >= ctx.doc.scenes.length - 1} onClick={() => go(1)} aria-label="Cảnh sau" title="Cảnh sau (])">
            <ChevronDown />
          </Button>
          {!ctx.readOnly && ctx.doc.scenes.length > 1 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-destructive"
              aria-label={`Bỏ cảnh ${scene.id}`}
              title={`Bỏ cảnh ${scene.id} (hoàn tác được)`}
              onClick={() => {
                const next = ctx.doc.scenes[ctx.selectedIndex + 1] ?? ctx.doc.scenes[ctx.selectedIndex - 1];
                ctx.update(`Bỏ cảnh ${scene.id}`, (d) => ({ ...d, scenes: d.scenes.filter((s) => s.id !== scene.id) }));
                if (next) ctx.select({ sceneId: next.id });
              }}
            >
              <Trash2 />
            </Button>
          ) : null}
        </span>
      </div>
      <div role="tablist" aria-label="Phần" className="flex gap-0.5 overflow-x-auto border-b px-2 scrollbar-none">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active?.id}
            onClick={() => ctx.ui.setTab(t.id)}
            className={cn("min-h-10 shrink-0 px-2.5 text-sm font-medium text-muted-foreground hover:text-foreground", t.id === active?.id && "text-foreground shadow-[inset_0_-2px_0_var(--primary)]")}
          >
            {t.title(ctx)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3">
        {Body ? <Body key={`${active.id}:${scene.id}`} /> : null}
      </div>
    </>
  );
}
