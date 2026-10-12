"use client";
import { useState } from "react";
import { Mic, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { sceneVoiceMs, type EditorScene, type EditorVisual } from "@/lib/media/editor";
import { sceneZones } from "@/lib/media/editor-checks";
import { frameStill } from "@/lib/media/framing";
import { useEditor, type EditorCtx } from "../core/context";
import { definePlugin } from "../core/plugin";
import { fmtSec, Note, Section } from "../shell/ui";

const VERDICT = { supported: { label: "Có căn cứ.", tone: "ok" }, partial: { label: "Một phần có căn cứ.", tone: "warn" }, unsupported: { label: "Không có căn cứ.", tone: "danger" } } as const;

/** Re-crop the scene's analysed stills for its overlays (the headline's size moves the zones). */
export function reframeScene(ctx: EditorCtx, s: EditorScene): EditorScene {
  const zones = sceneZones(ctx.doc, s, Boolean(ctx.doc.brand.logoSrc || ctx.props.previewLogo));
  const fix = (v: EditorVisual): EditorVisual => {
    const frame = v.kind === "image" ? (ctx.media.options.find((o) => o.key === v.key)?.frame ?? null) : null;
    if (v.kind !== "image" || !frame) return v;
    const f = frameStill(frame, zones);
    return { ...v, focus: f.focus, kenBurns: f.focus ? v.kenBurns && f.kenBurns : v.kenBurns };
  };
  return { ...s, visual: fix(s.visual), shots: s.shots.map(fix) };
}

function ContentTab() {
  const ctx = useEditor();
  const scene = ctx.selectedScene!;
  const verdict = ctx.props.verdicts?.[scene.id] ?? null;
  const draft = ctx.drafts.voice[scene.id] ?? scene.voiceover;
  const changed = draft.trim() !== scene.voiceover.trim();
  const [terms, setTerms] = useState(scene.brollTerms.join(", "));
  const [instruction, setInstruction] = useState("");
  const rewriting = ctx.pending.rewriting === scene.id;
  const words = draft.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-5 text-sm">
      {verdict ? (
        <Note tone={VERDICT[verdict.verdict].tone}>
          <span className="font-medium">Kiểm chứng: {VERDICT[verdict.verdict].label}</span> {verdict.note ?? ""}
          {verdict.evidence ? <p className="mt-1 border-l-2 pl-2 opacity-80">“{verdict.evidence}”</p> : null}
        </Note>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="ost" className="flex justify-between">
          Chữ trên màn hình <span className="font-mono text-[11px] font-normal text-muted-foreground">{scene.onScreenText.length}/120</span>
        </Label>
        <Input id="ost" value={scene.onScreenText} maxLength={120} disabled={ctx.readOnly} onChange={(e) => ctx.updateScene(scene.id, `${scene.id}: sửa chữ trên màn hình`, (s) => reframeScene(ctx, { ...s, onScreenText: e.target.value }), { coalesce: `${scene.id}.text` })} />
      </div>

      <Section title="Lời đọc" aside={<span className="text-[11px] text-muted-foreground">{words} từ · giọng hiện tại {fmtSec(sceneVoiceMs(scene) / 1000)}</span>}>
        <Textarea id="voiceover" rows={5} value={draft} maxLength={2000} disabled={!ctx.props.canEdit || rewriting} onChange={(e) => ctx.drafts.setVoice(scene.id, e.target.value)} className="text-sm leading-relaxed" aria-label="Lời đọc" />
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={changed ? "default" : "outline"} disabled={!ctx.canRegenerate || draft.trim().length < 2} title={ctx.regenerateHint ?? "Google TTS + mốc từ; trộn lại âm thanh; thành phiên bản mới"} onClick={() => ctx.services.regenerate("voice", { sceneId: scene.id, voiceover: draft.trim() })}>
            <Mic /> {changed ? "Đọc lại với lời mới" : "Đọc lại giọng"}
          </Button>
          <Button size="sm" variant="outline" disabled={!ctx.props.canEdit || Boolean(ctx.pending.rewriting)} onClick={() => void ctx.services.rewrite(scene.id, "shorter")}>
            <Sparkles /> Viết gọn hơn
          </Button>
          {verdict && verdict.verdict !== "supported" ? (
            <Button size="sm" variant="outline" disabled={!ctx.props.canEdit || Boolean(ctx.pending.rewriting)} onClick={() => void ctx.services.rewrite(scene.id, "faithful")}>
              Viết lại theo bài gốc
            </Button>
          ) : null}
          {changed ? (
            <Button size="sm" variant="ghost" onClick={() => ctx.drafts.setVoice(scene.id, scene.voiceover)}>
              Bỏ lời mới
            </Button>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <Input value={instruction} disabled={!ctx.props.canEdit || Boolean(ctx.pending.rewriting)} onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => e.key === "Enter" && instruction.trim() && (e.preventDefault(), void ctx.services.rewrite(scene.id, "custom", instruction.trim()))} placeholder="Yêu cầu Claude: “giọng trung tính hơn”, “nêu nguồn”…" className="h-8 min-w-0 flex-1 text-sm" aria-label="Yêu cầu viết lại" />
          <Button size="sm" variant="outline" disabled={!instruction.trim() || Boolean(ctx.pending.rewriting)} onClick={() => void ctx.services.rewrite(scene.id, "custom", instruction.trim())}>
            Viết lại
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{rewriting ? "Claude đang viết lại theo bài gốc…" : ctx.regenerateHint ?? "Claude chỉ gợi ý, không lưu gì; nghe ổn thì bấm “Đọc lại” để tạo giọng mới (chạy nền, thành phiên bản mới)."}</p>
      </Section>

      {scene.kind !== "cta" ? (
        <Section title="Tìm hình theo lời">
          {scene.newsTerms.length ? (
            <div className="flex flex-wrap gap-1 text-[11px]">
              <span className="text-muted-foreground">Theo lời bình:</span>
              {scene.newsTerms.map((t) => (
                <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
          <Label htmlFor="terms" className="text-xs font-normal text-muted-foreground">
            Từ khoá B-roll (tiếng Anh, phân cách bằng dấu phẩy)
          </Label>
          <div className="flex gap-1.5">
            <Input id="terms" value={terms} disabled={!ctx.canRegenerate || ctx.props.political} onChange={(e) => setTerms(e.target.value)} placeholder="city traffic aerial, metro construction" className="h-8 min-w-0 flex-1 text-sm" />
            <Button size="sm" variant="outline" disabled={!ctx.canRegenerate || (ctx.props.political ? !scene.newsTerms.length : !terms.trim())} title={ctx.regenerateHint ?? undefined} onClick={() => ctx.services.regenerate("broll", { sceneId: scene.id, brollTerms: terms.split(",").map((t) => t.trim()).filter(Boolean) })}>
              {ctx.props.political ? "Ảnh thật từ báo khác" : "Tìm hình mới"}
            </Button>
          </div>
          {ctx.props.political ? <p className="text-[11px] text-amber-700 dark:text-amber-400">Tin chính trị: không dùng stock hay ảnh AI, chỉ ảnh thật của người / nơi / sự kiện trong lời bình.</p> : null}
        </Section>
      ) : null}

      <Section title="Nhịp cảnh">
        <label className="flex items-center gap-3 text-xs">
          <span className="shrink-0">Giữ thêm sau lời</span>
          <input type="range" min={0} max={3000} step={100} value={scene.holdMs} disabled={ctx.readOnly} onChange={(e) => ctx.updateScene(scene.id, `${scene.id}: giữ thêm ${e.target.value} ms`, (s) => ({ ...s, holdMs: Number(e.target.value) }), { coalesce: `${scene.id}.hold` })} className="flex-1 accent-primary" aria-label="Giữ thêm sau lời (ms)" />
          <span className="w-14 text-right font-mono text-muted-foreground">{(scene.holdMs / 1000).toFixed(1)} s</span>
        </label>
        {ctx.doc.brand.overlaySrc ? (
          <label className="flex min-h-9 items-center justify-between text-xs">
            Lớp phủ của bộ nhận diện trên cảnh này
            <Switch checked={scene.overlay} disabled={ctx.readOnly} onCheckedChange={(on) => ctx.updateScene(scene.id, `${on ? "Bật" : "Tắt"} lớp phủ: ${scene.id}`, (s) => ({ ...s, overlay: on }))} aria-label="Lớp phủ trên cảnh này" />
          </label>
        ) : null}
      </Section>
    </div>
  );
}

/** Inspector "Nội dung": on-screen line, voice-over (re-voice, Claude rewrites), B-roll terms, pacing. */
export const contentTabPlugin = definePlugin({
  id: "inspector.content",
  name: "Nội dung cảnh",
  description: "Chữ trên màn hình, lời đọc (đọc lại, Claude viết gọn / theo bài gốc), từ khoá tìm hình, nhịp cảnh.",
  required: true,
  inspector: [{ id: "content", title: () => "Nội dung", order: 10, Component: ContentTab }],
  commands: [
    { id: "content.shorter", title: (c) => `Claude viết gọn lời ${c.selectedScene?.id ?? ""}`, group: "Cảnh", when: (c) => c.props.canEdit && Boolean(c.selectedScene), run: (c) => (c.ui.setTab("content"), void c.services.rewrite(c.selectedScene!.id, "shorter")) },
    { id: "content.revoice", title: (c) => `Đọc lại giọng ${c.selectedScene?.id ?? ""}`, group: "Cảnh", when: (c) => c.canRegenerate && Boolean(c.selectedScene), run: (c) => c.services.regenerate("voice", { sceneId: c.selectedScene!.id, voiceover: (c.drafts.voice[c.selectedScene!.id] ?? c.selectedScene!.voiceover).trim() }) },
  ],
});
