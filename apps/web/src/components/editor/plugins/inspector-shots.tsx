"use client";
import { useState } from "react";
import { ImageIcon, Plus, ScanFace, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SKETCH_STYLES, type SketchStyle } from "@ai-news/video/schema";
import { analyseVisual } from "@/app/app/projects/[id]/edit/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { removeShot, sceneShots, sceneVoiceMs, setSceneSketch, setShot, shotsMissing, SKETCH_LABEL, visualKey, visualLabel, type EditorVisual } from "@/lib/media/editor";
import { sceneZones } from "@/lib/media/editor-checks";
import { FRAMING_ISSUE_LABEL, frameStill } from "@/lib/media/framing";
import { formatTimecode } from "@/lib/media/visual-plan";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { Choice, fmtSec, Note, Section, Thumb } from "../shell/ui";
import { providerLabel } from "./media";

function ShotsTab() {
  const ctx = useEditor();
  const scene = ctx.selectedScene!;
  const shots = sceneShots(scene);
  const active = ctx.selection.shot;
  const shot = shots[active];
  const [busy, setBusy] = useState<string | null>(null);
  const hasLogo = Boolean(ctx.doc.brand.logoSrc || ctx.props.previewLogo);
  const zones = sceneZones(ctx.doc, scene, hasLogo);
  const perShot = sceneVoiceMs(scene) / 1000 / shots.length;
  const missing = shotsMissing(scene);
  const key = visualKey(shot);
  const dup = key ? (ctx.derived.usedKeys[key] ?? []).filter((at) => at !== scene.id && !at.startsWith(`${scene.id} `)) : [];
  const option = shot.kind === "video" || shot.kind === "image" ? (ctx.media.options.find((o) => (shot.assetId && o.assetId === shot.assetId) || o.key === shot.key) ?? null) : null;
  const frame = shot.kind === "image" ? (option?.frame ?? null) : null;
  const guard = frame ? frameStill(frame, zones) : null;
  const forScene = ctx.media.options.filter((o) => o.sceneId === scene.id).slice(0, 12);
  const label = `${scene.id}: hình ${active + 1}`;

  const setActive = (v: EditorVisual, what = "chỉnh") => ctx.updateScene(scene.id, `${label} ${what}`, (s) => setShot(s, active, v));

  const autoAlign = async () => {
    if (shot.kind !== "image") return;
    let f = frame;
    let found = "";
    if (!f) {
      if (!option) return void toast.error("Hình này không còn trong kho của dự án nên không phân tích được");
      setBusy("Đang nhận diện khuôn mặt…");
      try {
        const res = await analyseVisual({ projectId: ctx.props.projectId, assetId: option.assetId });
        if (!res.ok) return void toast.error(res.message);
        f = res.frame;
        found = `${res.message}. `;
        ctx.media.frameOption(option.assetId, res.frame);
      } finally {
        setBusy(null);
      }
    }
    const r = frameStill(f, zones);
    setActive({ ...shot, focus: r.focus, kenBurns: r.focus ? shot.kenBurns && r.kenBurns : shot.kenBurns }, "căn khung");
    if (!r.ok) toast.warning(`${found}Đã căn gần nhất có thể, nhưng vẫn còn: ${r.issues.map((i) => FRAMING_ISSUE_LABEL[i]).join(", ")}.`);
    else toast.success(r.faces ? `${found}Đã căn khung theo ${r.faces} khuôn mặt.` : "Không thấy khuôn mặt cần giữ: khung ở giữa.");
  };

  return (
    <div className="space-y-4 text-sm">
      <Section title={`Cảnh quay · ${shots.length}`} aside={<span className="text-[11px] text-muted-foreground">mỗi hình {fmtSec(perShot)}</span>}>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {shots.map((v, i) => {
            const t = ctx.derived.thumb(v);
            return (
              <button key={i} type="button" onClick={() => ctx.select({ shot: i })} aria-pressed={i === active} aria-label={`Hình ${i + 1}: ${visualLabel(v)}`} className={cn("relative h-24 w-14 shrink-0 overflow-hidden rounded-md border bg-neutral-800", i === active && "ring-2 ring-primary")}>
                <Thumb src={t.src} video={t.video} />
                <span className="absolute top-0 left-0 rounded-br bg-black/70 px-1 text-[10px] text-white">{i + 1}</span>
                <span className="absolute right-0 bottom-0 left-0 bg-black/60 px-1 text-[9px] text-white">{visualLabel(v)}</span>
              </button>
            );
          })}
          {!ctx.readOnly && shots.length < 13 ? (
            <button type="button" onClick={() => (ctx.updateScene(scene.id, `${scene.id}: thêm hình`, (s) => ({ ...s, shots: [...s.shots, { kind: "solid" }] })), ctx.select({ shot: shots.length }))} aria-label="Thêm cảnh quay" className="flex h-24 w-14 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:text-foreground">
              <Plus className="size-4" />
            </button>
          ) : null}
        </div>
        {missing > 0 ? <Note>Cảnh dài {fmtSec(sceneVoiceMs(scene) / 1000)} nhưng mỗi hình đứng {fmtSec(perShot)}. Thêm {missing} hình để đổi hình sau mỗi ≤ 5 s.</Note> : null}
        {dup.length ? <Note>Hình này cũng dùng ở {dup.join(", ")}. Mỗi hình chỉ nên xuất hiện một lần.</Note> : null}
        {guard && !guard.ok ? <Note>Khuôn mặt: {guard.issues.map((i) => FRAMING_ISSUE_LABEL[i]).join(", ")}. Nên đổi ảnh khác hoặc rút gọn chữ trên màn hình.</Note> : null}
      </Section>

      <Section
        title={`Hình ${active + 1}`}
        aside={
          !ctx.readOnly && shots.length > 1 ? (
            <Button size="xs" variant="ghost" className="text-destructive" onClick={() => (ctx.updateScene(scene.id, `${label} bỏ`, (s) => removeShot(s, active)), ctx.select({ shot: Math.max(0, active - 1) }))}>
              <Trash2 /> bỏ hình
            </Button>
          ) : null
        }
      >
        <p className="text-xs text-muted-foreground">
          {shot.kind === "video" ? `Clip ${shot.clipDurationSec.toFixed(0)} s` : shot.kind === "image" ? "Ảnh" : shot.kind === "solid" ? "Nền màu (tạm)" : `Đồ hoạ chuyển động (${shot.kind === "motion" ? "Remotion" : "HyperFrames"})`}
          {option ? ` · ${providerLabel(option.provider)}` : ""}
          {"credit" in shot && shot.credit ? ` · ${shot.credit}` : ""}
          {option?.sourceUrl ? (
            <>
              {" · "}
              <a href={option.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                nguồn ↗
              </a>
              {option.section ? ` ${formatTimecode(option.section[0])}–${formatTimecode(option.section[1])}` : ""}
            </>
          ) : null}
        </p>

        {!ctx.readOnly ? (
          <div className="space-y-1.5">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              <button type="button" onClick={() => setActive({ kind: "solid" }, "sang nền màu")} className={cn("flex h-20 w-11 shrink-0 items-center justify-center rounded-md border bg-neutral-800 text-[9px] text-white", shot.kind === "solid" && "ring-2 ring-primary")}>
                nền màu
              </button>
              {forScene.map((o) => {
                const used = ctx.derived.usedKeys[o.key] ?? [];
                return (
                  <button key={o.assetId} type="button" onClick={() => ctx.media.place(o, scene.id, active)} title={`${providerLabel(o.provider)}${used.length ? ` · đang dùng ở ${used.join(", ")}` : ""}`} className={cn("relative h-20 w-11 shrink-0 overflow-hidden rounded-md border bg-muted", o.key === key && "ring-2 ring-primary", used.length && o.key !== key && "opacity-50")}>
                    <Thumb src={o.thumbnailUrl ?? ctx.media.urls[o.key] ?? null} video={o.kind === "video" && !o.thumbnailUrl} />
                  </button>
                );
              })}
            </div>
            <Button size="xs" variant="outline" onClick={() => ctx.ui.setPanel("media")}>
              <ImageIcon /> Thư viện, tải lên, dán link…
            </Button>
          </div>
        ) : null}

        {shot.kind === "image" ? (
          <div className="space-y-3 pt-1">
            {!ctx.readOnly ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Button size="xs" variant="outline" disabled={Boolean(busy)} onClick={() => void autoAlign()} title="Nhận diện khuôn mặt rồi tự chọn khung 9:16: không cắt mặt, không để mặt dưới chữ / giao diện nền tảng, mặt ở 1/3 trên.">
                  <ScanFace /> Căn theo khuôn mặt
                </Button>
                <span className="text-muted-foreground">{busy ?? (shot.focus ? "đang căn theo khuôn mặt" : frame ? "khung giữa" : "chưa nhận diện")}</span>
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={shot.kenBurns} disabled={ctx.readOnly} onChange={(e) => setActive({ ...shot, kenBurns: e.target.checked }, "Ken Burns")} /> Ken Burns (phóng chậm)
            </label>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Ảnh thành tranh vẽ tay</span>
                {!ctx.readOnly && shots.filter((v) => v.kind === "image").length > 1 ? (
                  <Button size="xs" variant="ghost" onClick={() => ctx.updateScene(scene.id, `${scene.id}: kiểu vẽ cho mọi ảnh`, (s) => setSceneSketch(s, shot.sketch?.style ?? null, ctx.derived.isAiStill))}>
                    áp dụng cho cả cảnh
                  </Button>
                ) : null}
              </div>
              <Choice<"" | SketchStyle>
                label="Kiểu vẽ cho hình này"
                value={shot.sketch?.style ?? ""}
                disabled={ctx.readOnly}
                options={[{ value: "", label: "Gốc" }, ...SKETCH_STYLES.map((st) => ({ value: st, label: SKETCH_LABEL[st].replace("bút ", "") }))]}
                onChange={(v) => setActive({ ...shot, sketch: v ? { style: v } : null }, v ? `thành tranh ${SKETCH_LABEL[v]}` : "giữ ảnh gốc")}
              />
            </div>
          </div>
        ) : null}

        {shot.kind === "video" && shot.continuous ? (
          <p className="pt-1 text-xs text-muted-foreground">Video gốc phát liền từ cảnh này sang cảnh khác theo thời gian của video, hết thì phát lại từ đầu.</p>
        ) : shot.kind === "video" ? (
          <label className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            Cắt clip từ (giây)
            <Input type="number" min={0} max={Math.max(0, shot.clipDurationSec - 1)} step={0.5} value={shot.trimStartSec} disabled={ctx.readOnly} onChange={(e) => setActive({ ...shot, trimStartSec: Math.min(Math.max(0, Number(e.target.value) || 0), Math.max(0, shot.clipDurationSec - 1)) }, "cắt clip")} className="h-8 w-24" />
            <span className="text-muted-foreground">clip ngắn hơn cảnh quay sẽ lặp lại</span>
          </label>
        ) : null}
      </Section>
    </div>
  );
}

/** Inspector "Hình": the scene's shots (add, remove, swap, crop by faces, Ken Burns, hand-drawn look, trim). */
export const shotsTabPlugin = definePlugin({
  id: "inspector.shots",
  name: "Hình của cảnh",
  description: "Các cảnh quay của cảnh: thêm, bỏ, đổi hình, căn theo khuôn mặt, Ken Burns, ảnh vẽ tay, cắt clip.",
  required: true,
  inspector: [{ id: "shots", title: (c) => `Hình · ${c.selectedScene ? sceneShots(c.selectedScene).length : 0}`, order: 20, Component: ShotsTab }],
  commands: [
    {
      id: "shots.add",
      title: (c) => `Thêm hình vào ${c.selectedScene?.id ?? ""}`,
      group: "Cảnh",
      keys: "I",
      shortcut: { match: (e) => e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey && !e.altKey },
      when: (c) => !c.readOnly && Boolean(c.selectedScene) && sceneShots(c.selectedScene!).length < 13,
      run: (c) => {
        const s = c.selectedScene!;
        c.updateScene(s.id, `${s.id}: thêm hình`, (x) => ({ ...x, shots: [...x.shots, { kind: "solid" }] }));
        c.select({ shot: sceneShots(s).length });
        c.ui.setTab("shots");
        c.ui.setPanel("media");
      },
    },
  ],
});
