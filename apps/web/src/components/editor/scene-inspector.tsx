"use client";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SceneVerdict } from "@/lib/llm/schemas";
import { sceneCaptions, setCaptionText, type EditorScene, type EditorVisual } from "@/lib/media/editor";
import { cn } from "@/lib/utils";
import type { VisualOption } from "./types";

type Props = {
  scene: EditorScene;
  index: number;
  total: number;
  options: VisualOption[];
  urls: Record<string, string>;
  verdict: { verdict: SceneVerdict["verdict"]; note: string | null; evidence: string | null } | null;
  disabled: boolean;
  /** Regeneration needs a saved document and an idle project. */
  canRegenerate: boolean;
  regenerateHint: string | null;
  onChange: (scene: EditorScene) => void;
  onRemove: () => void;
  onRegenerate: (what: "voice" | "broll", payload: { voiceover?: string; brollTerms?: string[] }) => void;
  onSeek: () => void;
};

const verdictLabel = (v?: SceneVerdict["verdict"]) => (v === "supported" ? "Có căn cứ" : v === "partial" ? "Một phần" : v === "unsupported" ? "Không căn cứ" : "Chưa kiểm");

function OptionThumb({ o, url, selected, onPick }: { o: VisualOption; url: string | null; selected: boolean; onPick: () => void }) {
  const src = o.thumbnailUrl ?? url;
  return (
    <button type="button" onClick={onPick} title={`${o.provider}${o.searchTerm ? ` · ${o.searchTerm}` : ""}${o.rankScore != null ? ` · ${o.rankScore.toFixed(0)}/100` : ""}`} className={cn("relative h-24 w-14 shrink-0 overflow-hidden rounded border bg-muted", selected && "ring-2 ring-primary")}>
      {src ? (
        o.kind === "video" && !o.thumbnailUrl ? (
          <video src={src} muted preload="metadata" className="h-full w-full object-cover" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        )
      ) : null}
      <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 text-[9px] text-white">
        {o.kind === "video" ? `${o.durationSec?.toFixed(0) ?? "?"} s` : "ảnh"}
      </span>
    </button>
  );
}

/** Everything editable on one scene: headline, visual (swap/trim/hold), captions, voice and B-roll regeneration, faithfulness. */
export function SceneInspector({ scene, index, total, options, urls, verdict, disabled, canRegenerate, regenerateHint, onChange, onRemove, onRegenerate, onSeek }: Props) {
  const [voiceText, setVoiceText] = useState(scene.voiceover);
  const [terms, setTerms] = useState(scene.brollTerms.join(", "));
  const [showAll, setShowAll] = useState(false);
  const captions = useMemo(() => sceneCaptions(scene), [scene]);
  const forScene = options.filter((o) => o.sceneId === scene.id);
  const others = options.filter((o) => o.sceneId !== scene.id);
  const shown = showAll ? [...forScene, ...others] : forScene.length ? forScene : others.slice(0, 12);
  const setVisual = (visual: EditorVisual) => onChange({ ...scene, visual });
  const pick = (o: VisualOption) =>
    setVisual(
      o.kind === "video"
        ? { kind: "video", key: o.key, clipDurationSec: o.durationSec ?? 5, trimStartSec: 0, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl }
        : { kind: "image", key: o.key, kenBurns: true, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl },
    );
  const currentKey = scene.visual.kind === "solid" ? null : scene.visual.key;
  const voiceMs = scene.voice?.durationMs ?? scene.durationSec * 1000;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{scene.id}</Badge>
        <Badge variant="secondary">{scene.kind}</Badge>
        <span className="text-xs text-muted-foreground">
          cảnh {index + 1}/{total} · lời {(voiceMs / 1000).toFixed(1)} s
        </span>
        <button type="button" onClick={onSeek} className="text-xs underline">
          tua tới cảnh
        </button>
        {total > 1 && !disabled ? (
          <button type="button" onClick={onRemove} className="ml-auto text-xs text-destructive underline">
            bỏ cảnh
          </button>
        ) : null}
      </div>

      {verdict ? (
        <div className={cn("rounded-md border p-2 text-xs", verdict.verdict === "unsupported" && "border-destructive/50 bg-destructive/5")}>
          <span className="font-medium">Kiểm chứng: {verdictLabel(verdict.verdict)}.</span> {verdict.note ?? ""}
          {verdict.evidence ? <p className="mt-1 border-l-2 pl-2 text-muted-foreground">“{verdict.evidence}”</p> : null}
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="headline">Chữ trên màn hình</Label>
        <Input id="headline" value={scene.onScreenText} maxLength={120} disabled={disabled} onChange={(e) => onChange({ ...scene, onScreenText: e.target.value })} />
      </div>

      {/* ---- visual ---- */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Hình ảnh</Label>
          <span className="text-xs text-muted-foreground">
            {scene.visual.kind === "video" ? `clip ${scene.visual.clipDurationSec.toFixed(0)} s · ${scene.visual.credit ?? ""}` : scene.visual.kind === "image" ? `ảnh · ${scene.visual.credit ?? ""}` : "nền màu"}
          </span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button type="button" disabled={disabled} onClick={() => setVisual({ kind: "solid" })} className={cn("flex h-24 w-14 shrink-0 items-center justify-center rounded border bg-gradient-to-br from-slate-900 to-slate-700 text-[10px] text-white", scene.visual.kind === "solid" && "ring-2 ring-primary")}>
            nền màu
          </button>
          {shown.map((o) => (
            <OptionThumb key={o.assetId} o={o} url={urls[o.key] ?? null} selected={o.key === currentKey} onPick={() => !disabled && pick(o)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {forScene.length} ứng viên cho cảnh này · {others.length} từ cảnh khác
          </span>
          {others.length ? (
            <button type="button" className="underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "thu gọn" : "xem tất cả"}
            </button>
          ) : null}
        </div>
        {scene.visual.kind === "video" ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="trim">Cắt clip từ (giây)</Label>
              <Input
                id="trim"
                type="number"
                min={0}
                max={Math.max(0, scene.visual.clipDurationSec - 1)}
                step={0.5}
                value={scene.visual.trimStartSec}
                disabled={disabled}
                onChange={(e) => scene.visual.kind === "video" && setVisual({ ...scene.visual, trimStartSec: Math.min(Math.max(0, Number(e.target.value) || 0), Math.max(0, scene.visual.clipDurationSec - 1)) })}
                className="w-28"
              />
            </div>
            <span className="pb-2 text-xs text-muted-foreground">Clip ngắn hơn cảnh sẽ lặp lại.</span>
          </div>
        ) : scene.visual.kind === "image" ? (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={scene.visual.kenBurns} disabled={disabled} onChange={(e) => scene.visual.kind === "image" && setVisual({ ...scene.visual, kenBurns: e.target.checked })} /> hiệu ứng Ken Burns (phóng chậm)
          </label>
        ) : null}
        <div className="flex items-center gap-3">
          <Label htmlFor="hold" className="shrink-0">
            Giữ thêm sau lời
          </Label>
          <input id="hold" type="range" min={0} max={3000} step={100} value={scene.holdMs} disabled={disabled} onChange={(e) => onChange({ ...scene, holdMs: Number(e.target.value) })} className="flex-1" />
          <span className="w-16 text-right text-xs text-muted-foreground">{scene.holdMs} ms</span>
        </div>
      </div>

      {/* ---- captions ---- */}
      {scene.voice ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Phụ đề ({captions.length} dòng)</Label>
            {scene.captions ? (
              <button type="button" className="text-xs underline" disabled={disabled} onClick={() => onChange({ ...scene, captions: null })}>
                đặt lại tự động
              </button>
            ) : null}
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {captions.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{(c.startMs / 1000).toFixed(1)}s</span>
                <Input
                  value={c.text}
                  disabled={disabled}
                  className="h-8 text-sm"
                  onChange={(e) => {
                    const next = captions.map((x, j) => (j === i ? setCaptionText(x, e.target.value) : x));
                    onChange({ ...scene, captions: next });
                  }}
                />
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Sửa chữ chỉ đổi phụ đề hiển thị; lời đọc giữ nguyên. Muốn đổi lời, đọc lại bên dưới.</p>
        </div>
      ) : null}

      {/* ---- regenerate ---- */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="text-xs font-medium">Tạo lại (chạy nền, thành phiên bản mới)</div>
        {regenerateHint ? <p className="text-xs text-amber-700 dark:text-amber-400">{regenerateHint}</p> : null}
        <div className="space-y-1">
          <Label htmlFor="voiceover">Lời đọc</Label>
          <Textarea id="voiceover" rows={3} value={voiceText} maxLength={2000} disabled={!canRegenerate} onChange={(e) => setVoiceText(e.target.value)} className="text-sm" />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={!canRegenerate || voiceText.trim().length < 2} onClick={() => onRegenerate("voice", { voiceover: voiceText.trim() })}>
              {voiceText.trim() !== scene.voiceover ? "Đọc lại với lời mới" : "Đọc lại lời"}
            </Button>
            <span className="text-[11px] text-muted-foreground">Google TTS + mốc từ; mix lại âm thanh.</span>
          </div>
        </div>
        {scene.kind !== "cta" ? (
          <div className="space-y-1">
            <Label htmlFor="terms">Từ khoá B-roll (tiếng Anh, phân cách bằng dấu phẩy)</Label>
            <Input id="terms" value={terms} disabled={!canRegenerate} onChange={(e) => setTerms(e.target.value)} placeholder="city traffic aerial, metro construction" />
            <Button type="button" size="sm" variant="outline" disabled={!canRegenerate || !terms.trim()} onClick={() => onRegenerate("broll", { brollTerms: terms.split(",").map((t) => t.trim()).filter(Boolean) })}>
              Tìm B-roll mới
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
