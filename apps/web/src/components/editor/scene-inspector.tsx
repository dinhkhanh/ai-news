"use client";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { analyseVisual, createUploadUrl, importVisualFromUrl, registerUpload } from "@/app/app/projects/[id]/edit/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TextLayoutInput } from "@ai-news/video/schema";
import type { SceneVerdict } from "@/lib/llm/schemas";
import { removeShot, sceneCaptions, sceneShots, sceneVoiceMs, setCaptionText, setShot, shotsMissing, type EditorScene, type EditorVisual } from "@/lib/media/editor";
import { FRAMING_ISSUE_LABEL, frameStill, overlayZones, type FrameFaces } from "@/lib/media/framing";
import { cn } from "@/lib/utils";
import type { VisualOption } from "./types";

type Props = {
  projectId: string;
  scene: EditorScene;
  index: number;
  total: number;
  options: VisualOption[];
  /** Brand overlays the face guard has to keep faces clear of. */
  overlay: { caption: TextLayoutInput["caption"]; headlineStyle: TextLayoutInput["headline"]; showSource: boolean; hasLogo: boolean };
  /** The document's brand kit has an overlay PNG (else the per-scene switch is pointless). */
  hasOverlay: boolean;
  urls: Record<string, string>;
  /** R2 key → where else in the video it is used ("s3", "s3 #2"); a picture should appear once. */
  usedKeys: Record<string, string[]>;
  verdict: { verdict: SceneVerdict["verdict"]; note: string | null; evidence: string | null } | null;
  disabled: boolean;
  /** Regeneration needs a saved document and an idle project. */
  canRegenerate: boolean;
  regenerateHint: string | null;
  onChange: (scene: EditorScene) => void;
  onRemove: () => void;
  onRegenerate: (what: "voice" | "broll", payload: { voiceover?: string; brollTerms?: string[] }) => void;
  onSeek: () => void;
  /** An uploaded / linked file became a swap option (with its presigned URL for the preview). */
  onOptionAdded: (option: VisualOption, url: string) => void;
  /** Faces of a picture were just detected on request; the parent keeps them on the option. */
  onOptionFramed: (assetId: string, frame: FrameFaces) => void;
};

const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm";
const verdictLabel = (v?: SceneVerdict["verdict"]) => (v === "supported" ? "Có căn cứ" : v === "partial" ? "Một phần" : v === "unsupported" ? "Không căn cứ" : "Chưa kiểm");

/** Dimensions / duration of a local file or a URL, read in the browser (no server probe needed). */
function probeMedia(src: string, kind: "image" | "video"): Promise<{ width: number | null; height: number | null; durationSec: number | null }> {
  return new Promise((resolve) => {
    const done = (v: { width: number | null; height: number | null; durationSec: number | null }) => resolve(v);
    const timer = setTimeout(() => done({ width: null, height: null, durationSec: null }), 15_000);
    if (kind === "image") {
      const im = new Image();
      im.onload = () => (clearTimeout(timer), done({ width: im.naturalWidth, height: im.naturalHeight, durationSec: null }));
      im.onerror = () => (clearTimeout(timer), done({ width: null, height: null, durationSec: null }));
      im.src = src;
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => (clearTimeout(timer), done({ width: v.videoWidth || null, height: v.videoHeight || null, durationSec: Number.isFinite(v.duration) ? v.duration : null }));
      v.onerror = () => (clearTimeout(timer), done({ width: null, height: null, durationSec: null }));
      v.src = src;
    }
  });
}

const fromOption = (o: VisualOption, durationSec?: number | null): EditorVisual =>
  o.kind === "video"
    ? { kind: "video", key: o.key, clipDurationSec: durationSec ?? o.durationSec ?? 5, trimStartSec: 0, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl }
    : { kind: "image", key: o.key, kenBurns: true, focus: null, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl };

function Thumb({ src, video, className }: { src: string | null; video: boolean; className?: string }) {
  if (!src) return null;
  return video ? (
    <video src={src} muted preload="metadata" className={cn("h-full w-full object-cover", className)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn("h-full w-full object-cover", className)} loading="lazy" />
  );
}

function OptionThumb({ o, url, selected, usedAt, onPick }: { o: VisualOption; url: string | null; selected: boolean; usedAt: string[]; onPick: () => void }) {
  const src = o.thumbnailUrl ?? url;
  const providerLabel = o.provider === "related" ? "báo khác" : o.provider === "article" ? "bài gốc" : o.provider === "gemini_image" ? "AI" : o.provider === "yt-dlp" || o.provider === "yt-capture" ? "video web" : o.provider === "upload" ? "tải lên" : o.provider === "url" ? "đường dẫn" : o.provider;
  return (
    <button
      type="button"
      onClick={onPick}
      title={`${providerLabel}${o.searchTerm ? ` · ${o.searchTerm}` : ""}${o.rankScore != null ? ` · ${o.rankScore.toFixed(0)}/100` : ""}${usedAt.length ? ` · đã dùng ở ${usedAt.join(", ")}` : ""}`}
      className={cn("relative h-24 w-14 shrink-0 overflow-hidden rounded border bg-muted", selected && "ring-2 ring-primary", usedAt.length && !selected && "opacity-50")}
    >
      <Thumb src={src} video={o.kind === "video" && !o.thumbnailUrl} />
      <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 text-[9px] text-white">{o.kind === "video" ? `${o.durationSec?.toFixed(0) ?? "?"} s` : providerLabel}</span>
      {usedAt.length ? <span className="absolute left-0 top-0 rounded-br bg-amber-500 px-1 text-[9px] text-black">đã dùng</span> : null}
    </button>
  );
}

/** Everything editable on one scene: headline, shots (swap/upload/link/trim/hold), captions, voice and B-roll regeneration, faithfulness. */
export function SceneInspector({ projectId, scene, index, total, options, overlay, hasOverlay, urls, usedKeys, verdict, disabled, canRegenerate, regenerateHint, onChange, onRemove, onRegenerate, onSeek, onOptionAdded, onOptionFramed }: Props) {
  const [voiceText, setVoiceText] = useState(scene.voiceover);
  const [terms, setTerms] = useState(scene.brollTerms.join(", "));
  const [showAll, setShowAll] = useState(false);
  const [shotIdx, setShotIdx] = useState(0);
  const [linkUrl, setLinkUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const captions = useMemo(() => sceneCaptions(scene), [scene]);
  const shots = sceneShots(scene);
  const active = Math.min(shotIdx, shots.length - 1);
  const shot = shots[active];
  const forScene = options.filter((o) => o.sceneId === scene.id);
  const others = options.filter((o) => o.sceneId !== scene.id);
  const shown = showAll ? [...forScene, ...others] : forScene.length ? forScene : others.slice(0, 12);
  const voiceMs = sceneVoiceMs(scene);
  const missing = shotsMissing(scene);
  const perShotSec = voiceMs / 1000 / shots.length;
  const usedElsewhere = (key: string) => (usedKeys[key] ?? []).filter((at) => !at.startsWith(`${scene.id} `) && at !== scene.id);
  const currentKey = shot.kind === "solid" ? null : shot.key;
  const dupHere = currentKey ? usedElsewhere(currentKey) : [];

  // Face guard (lib/media/framing.ts): pictures analysed by the build or on upload are re-cropped for this scene's overlays.
  const zonesOf = (s: EditorScene) => overlayZones({ kind: s.kind, headline: s.onScreenText, hasCaptions: Boolean(s.voice), ...overlay });
  const frameOf = (key: string) => options.find((o) => o.key === key)?.frame ?? null;
  const reframe = (s: EditorScene): EditorScene => {
    const zones = zonesOf(s);
    const fix = (v: EditorVisual): EditorVisual => {
      const frame = v.kind === "image" ? frameOf(v.key) : null;
      if (v.kind !== "image" || !frame) return v;
      const f = frameStill(frame, zones);
      return { ...v, focus: f.focus, kenBurns: f.focus ? v.kenBurns && f.kenBurns : v.kenBurns };
    };
    return { ...s, visual: fix(s.visual), shots: s.shots.map(fix) };
  };
  const shotFrame = shot.kind === "image" ? frameOf(shot.key) : null;
  const guard = shotFrame ? frameStill(shotFrame, zonesOf(scene)) : null;

  const setActive = (visual: EditorVisual) => onChange(setShot(scene, active, visual));
  const pick = (o: VisualOption) => onChange(reframe(setShot(scene, active, fromOption(o))));
  const addShot = () => {
    onChange({ ...scene, shots: [...scene.shots, { kind: "solid" }] });
    setShotIdx(shots.length);
  };
  const dropShot = () => {
    onChange(removeShot(scene, active));
    setShotIdx(Math.max(0, active - 1));
  };

  const applyAdded = async (res: { ok: true; option: VisualOption; url: string; message: string } | { ok: false; message: string }, probeUrl?: string) => {
    if (!res.ok) return void toast.error(res.message);
    let option = res.option;
    if (option.kind === "video" && !option.durationSec && probeUrl) {
      const p = await probeMedia(probeUrl, "video");
      option = { ...option, durationSec: p.durationSec };
    }
    onOptionAdded(option, res.url);
    const added = fromOption(option);
    // The new option is not in `options` yet, so frame it from the faces the server just returned.
    const f = added.kind === "image" && option.frame ? frameStill(option.frame, zonesOf(scene)) : null;
    setActive(added.kind === "image" && f ? { ...added, focus: f.focus, kenBurns: f.kenBurns } : added);
    toast.success(res.message);
  };

  // Manual auto-align of the active picture: detect faces if nobody has yet (uploads added while the guard was off, stock, AI stills), then crop for this scene's overlays.
  const autoAlign = async () => {
    if (shot.kind !== "image") return;
    const option = options.find((o) => (shot.assetId ? o.assetId === shot.assetId : o.key === shot.key)) ?? null;
    let frame = option?.frame ?? null;
    let found = "";
    if (!frame) {
      if (!option) return void toast.error("Hình này không còn trong kho của dự án nên không phân tích được");
      setBusy("Đang nhận diện khuôn mặt…");
      try {
        const res = await analyseVisual({ projectId, assetId: option.assetId });
        if (!res.ok) return void toast.error(res.message);
        frame = res.frame;
        found = `${res.message}. `;
        onOptionFramed(option.assetId, res.frame);
      } finally {
        setBusy(null);
      }
    }
    const f = frameStill(frame, zonesOf(scene));
    setActive({ ...shot, focus: f.focus, kenBurns: f.focus ? shot.kenBurns && f.kenBurns : shot.kenBurns });
    if (!f.ok) toast.warning(`${found}Đã căn gần nhất có thể, nhưng vẫn còn: ${f.issues.map((i) => FRAMING_ISSUE_LABEL[i]).join(", ")}.`);
    else toast.success(f.faces ? `${found}Đã căn khung theo ${f.faces} khuôn mặt. Bấm Lưu để giữ.` : "Không thấy khuôn mặt cần giữ: khung ở giữa.");
  };

  const upload = async (file: File) => {
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
    if (!kind) return void toast.error("Chỉ nhận JPG, PNG, WebP, MP4, MOV hoặc WebM");
    setBusy("Đang tải lên…");
    try {
      const ticket = await createUploadUrl({ projectId, filename: file.name, contentType: file.type, sizeBytes: file.size });
      if (!ticket.ok) throw new Error(ticket.message);
      const objectUrl = URL.createObjectURL(file);
      const probe = await probeMedia(objectUrl, kind).finally(() => URL.revokeObjectURL(objectUrl));
      const put = await fetch(ticket.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } }).catch(() => null);
      if (!put || !put.ok) throw new Error(put ? `Tải lên thất bại (HTTP ${put.status})` : "Tải lên thất bại: trình duyệt bị chặn (CORS của bucket R2 chưa cho phép domain này, xem infra/r2/cors.json)");
      const res = await registerUpload({ projectId, key: ticket.key, filename: file.name, contentType: file.type, width: probe.width, height: probe.height, durationSec: probe.durationSec });
      await applyAdded(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Tải lên thất bại");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const importUrl = async () => {
    const url = linkUrl.trim();
    if (!url) return;
    setBusy("Đang lấy tệp từ đường dẫn…");
    try {
      const res = await importVisualFromUrl({ projectId, url });
      await applyAdded(res, res.ok ? res.url : undefined);
      if (res.ok) setLinkUrl("");
    } finally {
      setBusy(null);
    }
  };

  const thumbOf = (v: EditorVisual) => (v.kind === "solid" ? { src: null, video: false } : v.thumbnailUrl ? { src: v.thumbnailUrl, video: false } : { src: urls[v.key] ?? null, video: v.kind === "video" });

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
        <Input id="headline" value={scene.onScreenText} maxLength={120} disabled={disabled} onChange={(e) => onChange(reframe({ ...scene, onScreenText: e.target.value }))} />
      </div>

      {/* ---- shots ---- */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Cảnh quay ({shots.length}) · mỗi hình {perShotSec.toFixed(1)} s</Label>
          {!disabled ? (
            <div className="flex gap-2 text-xs">
              <button type="button" className="underline" onClick={addShot} disabled={shots.length >= 13}>
                + thêm cảnh quay
              </button>
              {shots.length > 1 ? (
                <button type="button" className="text-destructive underline" onClick={dropShot}>
                  bỏ cảnh quay {active + 1}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {shots.map((v, i) => {
            const t = thumbOf(v);
            return (
              <button key={i} type="button" onClick={() => setShotIdx(i)} className={cn("relative h-24 w-14 shrink-0 overflow-hidden rounded border bg-gradient-to-br from-slate-900 to-slate-700", i === active && "ring-2 ring-primary")} title={v.kind === "solid" ? "nền màu" : v.key}>
                <Thumb src={t.src} video={t.video} />
                <span className="absolute left-0 top-0 rounded-br bg-black/70 px-1 text-[10px] text-white">{i + 1}</span>
                <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 text-[9px] text-white">{v.kind === "video" ? "clip" : v.kind === "image" ? "ảnh" : "nền màu"}</span>
              </button>
            );
          })}
        </div>
        {missing > 0 ? (
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
            Cảnh dài {(voiceMs / 1000).toFixed(1)} s nhưng chỉ có {shots.length} hình ({perShotSec.toFixed(1)} s/hình). Thêm {missing} hình nữa để đổi hình mỗi ≤ 5 s.
          </p>
        ) : null}
        {guard && !guard.ok ? (
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
            Kiểm tra khuôn mặt: {guard.issues.map((i) => FRAMING_ISSUE_LABEL[i]).join(", ")}. Khung 9:16 không giữ trọn khuôn mặt ở 2/3 trên màn hình; nên đổi ảnh khác hoặc rút gọn chữ trên màn hình.
          </p>
        ) : null}
        {dupHere.length ? <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">Hình này cũng dùng ở {dupHere.join(", ")}. Mỗi hình chỉ nên xuất hiện một lần trong video.</p> : null}

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Cảnh quay {active + 1}: {shot.kind === "video" ? `clip ${shot.clipDurationSec.toFixed(0)} s · ${shot.credit ?? ""}` : shot.kind === "image" ? `ảnh · ${shot.credit ?? ""}` : "nền màu"}
          </span>
          {shot.kind === "image" && !disabled ? (
            <>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={Boolean(busy)} onClick={() => void autoAlign()} title="Nhận diện khuôn mặt trong ảnh này rồi tự chọn khung 9:16: không cắt mặt, không để mặt dưới chữ / giao diện nền tảng, mặt nằm ở 1/3 trên.">
                Tự căn khuôn mặt
              </Button>
              <span>{shot.focus ? "đang căn theo khuôn mặt" : shotFrame ? "khung giữa" : "chưa nhận diện"}</span>
            </>
          ) : null}
        </div>

        {/* swap options for the active shot */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button type="button" disabled={disabled} onClick={() => setActive({ kind: "solid" })} className={cn("flex h-24 w-14 shrink-0 items-center justify-center rounded border bg-gradient-to-br from-slate-900 to-slate-700 text-[10px] text-white", shot.kind === "solid" && "ring-2 ring-primary")}>
            nền màu
          </button>
          {shown.map((o) => (
            <OptionThumb key={o.assetId} o={o} url={urls[o.key] ?? null} selected={o.key === currentKey} usedAt={usedElsewhere(o.key)} onPick={() => !disabled && pick(o)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {forScene.length} ứng viên cho cảnh này · {others.length} khác trong dự án
          </span>
          {others.length ? (
            <button type="button" className="underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "thu gọn" : "xem tất cả"}
            </button>
          ) : null}
        </div>

        {/* upload / link */}
        {!disabled ? (
          <div className="space-y-2 rounded-md border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
              <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
                Tải ảnh / video lên
              </Button>
              <span className="text-[11px] text-muted-foreground">JPG, PNG, WebP, MP4, MOV, WebM · tối đa 200 MB · thay cho cảnh quay {active + 1}</span>
            </div>
            <div className="flex items-center gap-2">
              <Input value={linkUrl} disabled={Boolean(busy)} placeholder="https://…/anh.jpg hoặc …/clip.mp4 (link trực tiếp tới tệp)" onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void importUrl())} className="h-8 text-sm" />
              <Button type="button" size="sm" variant="outline" disabled={Boolean(busy) || !/^https?:\/\//i.test(linkUrl.trim())} onClick={() => void importUrl()}>
                Lấy
              </Button>
            </div>
            {busy ? <p className="text-[11px] text-muted-foreground">{busy}</p> : null}
          </div>
        ) : null}

        {shot.kind === "video" ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="trim">Cắt clip từ (giây)</Label>
              <Input
                id="trim"
                type="number"
                min={0}
                max={Math.max(0, shot.clipDurationSec - 1)}
                step={0.5}
                value={shot.trimStartSec}
                disabled={disabled}
                onChange={(e) => shot.kind === "video" && setActive({ ...shot, trimStartSec: Math.min(Math.max(0, Number(e.target.value) || 0), Math.max(0, shot.clipDurationSec - 1)) })}
                className="w-28"
              />
            </div>
            <span className="pb-2 text-xs text-muted-foreground">Clip ngắn hơn cảnh quay sẽ lặp lại.</span>
          </div>
        ) : shot.kind === "image" ? (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={shot.kenBurns} disabled={disabled} onChange={(e) => shot.kind === "image" && setActive({ ...shot, kenBurns: e.target.checked })} /> hiệu ứng Ken Burns (phóng chậm)
          </label>
        ) : null}
        <div className="flex items-center gap-3">
          <Label htmlFor="hold" className="shrink-0">
            Giữ thêm sau lời
          </Label>
          <input id="hold" type="range" min={0} max={3000} step={100} value={scene.holdMs} disabled={disabled} onChange={(e) => onChange({ ...scene, holdMs: Number(e.target.value) })} className="flex-1" />
          <span className="w-16 text-right text-xs text-muted-foreground">{scene.holdMs} ms</span>
        </div>
        {hasOverlay ? (
          <label className="flex items-center gap-2 text-xs" title="Lớp phủ PNG của bộ nhận diện, phủ suốt cảnh này từ khung hình đầu tới cuối">
            <input type="checkbox" checked={scene.overlay} disabled={disabled} onChange={(e) => onChange({ ...scene, overlay: e.target.checked })} /> lớp phủ của bộ nhận diện trên cảnh này
          </label>
        ) : null}
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
