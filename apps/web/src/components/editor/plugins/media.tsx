"use client";
import { useMemo, useRef, useState } from "react";
import { ImageIcon, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { createUploadUrl, importVisualFromUrl, importWebVideo, registerUpload, type VisualAdded } from "@/app/app/projects/[id]/edit/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_MANUAL_SECTION_SEC, MAX_MANUAL_SECTION_SEC, parseTimecode, webVideoPageUrl } from "@/lib/media/visual-plan";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { PanelHeader, Thumb } from "../shell/ui";
import type { VisualOption } from "../types";
import { WebCapturePanel } from "../web-capture-panel";

/** dataTransfer type for an option dragged from the library onto the timeline's shot row. */
export const ASSET_DRAG_TYPE = "application/x-ai-news-asset";

const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm";

export const providerLabel = (p: string) =>
  p === "related" ? "báo khác" : p === "article" ? "bài gốc" : p === "gemini_image" ? "ảnh AI" : p === "yt-dlp" || p === "yt-capture" ? "video web" : p === "upload" ? "tải lên" : p === "url" ? "đường dẫn" : p;

/** Dimensions / duration of a local file or a URL, read in the browser (no server probe needed). */
function probeMedia(src: string, kind: "image" | "video"): Promise<{ width: number | null; height: number | null; durationSec: number | null }> {
  return new Promise((resolve) => {
    const none = { width: null, height: null, durationSec: null };
    const timer = setTimeout(() => resolve(none), 15_000);
    if (kind === "image") {
      const im = new Image();
      im.onload = () => (clearTimeout(timer), resolve({ width: im.naturalWidth, height: im.naturalHeight, durationSec: null }));
      im.onerror = () => (clearTimeout(timer), resolve(none));
      im.src = src;
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => (clearTimeout(timer), resolve({ width: v.videoWidth || null, height: v.videoHeight || null, durationSec: Number.isFinite(v.duration) ? v.duration : null }));
      v.onerror = () => (clearTimeout(timer), resolve(none));
      v.src = src;
    }
  });
}

function OptionTile({ o }: { o: VisualOption }) {
  const ctx = useEditor();
  const used = ctx.derived.usedKeys[o.key] ?? [];
  const src = o.thumbnailUrl ?? ctx.media.urls[o.key] ?? null;
  const target = ctx.selectedScene;
  const label = `${providerLabel(o.provider)}${o.searchTerm ? ` · ${o.searchTerm}` : ""}${o.rankScore != null ? ` · ${o.rankScore.toFixed(0)}/100` : ""}${used.length ? ` · đang dùng ở ${used.join(", ")}` : ""}`;
  return (
    <li>
      <button
        type="button"
        draggable={!ctx.readOnly}
        onDragStart={(e) => {
          e.dataTransfer.setData(ASSET_DRAG_TYPE, o.assetId);
          e.dataTransfer.effectAllowed = "copy";
        }}
        disabled={ctx.readOnly || !target}
        onClick={() => target && ctx.media.place(o, target.id, ctx.selection.shot)}
        title={`${label}${target ? ` — bấm để đặt vào ${target.id} hình ${ctx.selection.shot + 1}, hoặc kéo vào hàng Hình` : ""}`}
        aria-label={label}
        className={cn("relative block aspect-[9/16] w-full overflow-hidden rounded-md border bg-muted disabled:cursor-default", used.length && "opacity-60")}
      >
        <Thumb src={src} video={o.kind === "video" && !o.thumbnailUrl} />
        <span className="absolute top-1 left-1 rounded bg-black/60 px-1 text-[9px] text-white">{o.kind === "video" ? `${o.durationSec?.toFixed(0) ?? "?"} s` : providerLabel(o.provider)}</span>
        {used.length ? <span className="absolute top-1 right-1 rounded bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{used[0]}</span> : null}
        {o.sceneId ? <span className="absolute right-0 bottom-0 left-0 truncate bg-black/60 px-1 text-[9px] text-white">cho {o.sceneId}</span> : null}
      </button>
    </li>
  );
}

function MediaPanel() {
  const ctx = useEditor();
  const sources = ctx.plugins.contributions.mediaSources;
  const [source, setSource] = useState<string>("all");
  const [q, setQ] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkFrom, setLinkFrom] = useState("");
  const [linkTo, setLinkTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const target = ctx.selectedScene;
  const shot = ctx.selection.shot;

  const linkIsPage = Boolean(webVideoPageUrl(linkUrl));
  const fromSec = parseTimecode(linkFrom);
  const toSec = parseTimecode(linkTo);
  const timesOk = (!linkFrom.trim() || fromSec != null) && (!linkTo.trim() || toSec != null) && (fromSec == null || toSec == null || toSec > fromSec);

  const shown = useMemo(() => {
    const src = sources.find((s) => s.id === source);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return ctx.media.options.filter((o) => (!src || src.match(o, ctx)) && words.every((w) => `${o.searchTerm ?? ""} ${o.credit ?? ""} ${providerLabel(o.provider)}`.toLowerCase().includes(w)));
  }, [ctx, sources, source, q]);

  // A new file / link becomes an option and goes into the selected shot (the inspector's old behaviour).
  const applyAdded = async (res: VisualAdded, probeUrl?: string) => {
    if (!res.ok) return void toast.error(res.message);
    let option = res.option;
    if (option.kind === "video" && !option.durationSec && probeUrl) option = { ...option, durationSec: (await probeMedia(probeUrl, "video")).durationSec };
    ctx.media.addOption(option, res.url);
    if (target && !ctx.readOnly) ctx.media.place(option, target.id, shot);
    toast.success(target ? `${res.message} · đặt vào ${target.id} hình ${shot + 1}` : res.message);
  };

  const upload = async (file: File) => {
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
    if (!kind) return void toast.error("Chỉ nhận JPG, PNG, WebP, MP4, MOV hoặc WebM");
    setBusy("Đang tải lên…");
    try {
      const ticket = await createUploadUrl({ projectId: ctx.props.projectId, filename: file.name, contentType: file.type, sizeBytes: file.size });
      if (!ticket.ok) throw new Error(ticket.message);
      const objectUrl = URL.createObjectURL(file);
      const probe = await probeMedia(objectUrl, kind).finally(() => URL.revokeObjectURL(objectUrl));
      const put = await fetch(ticket.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } }).catch(() => null);
      if (!put || !put.ok) throw new Error(put ? `Tải lên thất bại (HTTP ${put.status})` : "Tải lên thất bại: trình duyệt bị chặn (CORS của bucket R2 chưa cho phép domain này, xem infra/r2/cors.json)");
      await applyAdded(await registerUpload({ projectId: ctx.props.projectId, key: ticket.key, filename: file.name, contentType: file.type, width: probe.width, height: probe.height, durationSec: probe.durationSec }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Tải lên thất bại");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const importUrl = async () => {
    const url = linkUrl.trim();
    if (!url || !timesOk) return;
    try {
      if (linkIsPage) {
        // A video page is resolved and cut on the server; YouTube the server cannot reach goes to the in-browser recorder.
        setBusy("Đang đọc trang video và tải đoạn đã chọn…");
        const res = await importWebVideo({ projectId: ctx.props.projectId, url, startSec: fromSec, endSec: toSec, sceneId: target?.id ?? ctx.doc.scenes[0].id, shot });
        if (!res.ok && "capture" in res) {
          ctx.media.addCapture(res.capture);
          return void toast.warning(res.message, { duration: 10_000 });
        }
        await applyAdded(res);
      } else {
        setBusy("Đang lấy tệp từ đường dẫn…");
        const res = await importVisualFromUrl({ projectId: ctx.props.projectId, url });
        await applyAdded(res, res.ok ? res.url : undefined);
      }
      setLinkUrl("");
      setLinkFrom("");
      setLinkTo("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 pb-3">
      <PanelHeader title="Thư viện hình" meta={ctx.media.options.length}>
        <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <Button size="xs" variant="outline" disabled={ctx.readOnly || Boolean(busy)} onClick={() => fileRef.current?.click()}>
          <Upload /> Tải lên
        </Button>
      </PanelHeader>
      {ctx.media.captures.length ? (
        <div className="px-3">
          <WebCapturePanel projectId={ctx.props.projectId} captures={ctx.media.captures} disabled={ctx.readOnly} onCaptured={ctx.media.placeCapture} />
        </div>
      ) : null}
      {!ctx.readOnly ? (
        <div className="space-y-1.5 px-3">
          <div className="flex gap-1.5">
            <Input value={linkUrl} inputMode="url" disabled={Boolean(busy)} placeholder="Dán link ảnh, video, YouTube, TikTok…" onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void importUrl())} className="h-8 min-w-0 flex-1 text-sm" aria-label="Link ảnh hoặc video" />
            <Button size="sm" variant="outline" disabled={Boolean(busy) || !/^https?:\/\//i.test(linkUrl.trim()) || !timesOk} onClick={() => void importUrl()}>
              Lấy
            </Button>
          </div>
          {linkIsPage ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              từ
              <Input value={linkFrom} placeholder="0:00" onChange={(e) => setLinkFrom(e.target.value)} className={cn("h-7 w-16 text-xs", linkFrom.trim() && fromSec == null && "border-destructive")} aria-label="Bắt đầu (phút:giây)" />
              đến
              <Input value={linkTo} placeholder={`+${DEFAULT_MANUAL_SECTION_SEC}s`} onChange={(e) => setLinkTo(e.target.value)} className={cn("h-7 w-16 text-xs", ((linkTo.trim() && toSec == null) || !timesOk) && "border-destructive")} aria-label="Kết thúc (phút:giây)" />
              <span>tối đa {MAX_MANUAL_SECTION_SEC} s, ghi nguồn kênh</span>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">{busy ?? (target ? `Bấm một hình để đặt vào ${target.id} · hình ${shot + 1}, hoặc kéo vào hàng Hình.` : "Chọn một cảnh để đặt hình.")}</p>
        </div>
      ) : null}
      <div className="space-y-2 px-3">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-input bg-card px-2 text-muted-foreground focus-within:border-ring">
          <Search className="size-3.5" />
          <span className="sr-only">Tìm trong thư viện</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo từ khoá, nguồn" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" />
        </label>
        <div role="group" aria-label="Nguồn" className="flex flex-wrap gap-1">
          {[{ id: "all", label: "Tất cả" }, ...sources].map((s) => (
            <button key={s.id} type="button" aria-pressed={source === s.id} onClick={() => setSource(s.id)} className={cn("min-h-7 rounded-full border px-2.5 text-xs pointer-coarse:min-h-9", source === s.id ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <ul className="grid grid-cols-3 gap-1.5 px-3">
          {shown.map((o) => (
            <OptionTile key={o.assetId} o={o} />
          ))}
        </ul>
      ) : (
        <p className="px-3 text-xs text-muted-foreground">Không có hình nào ở đây. Tải lên hoặc dán một link.</p>
      )}
    </div>
  );
}

/** The project's pictures and clips: filter, search, upload, paste links (files, video pages), drag onto the timeline. */
export const mediaPlugin = definePlugin({
  id: "media",
  name: "Thư viện hình",
  description: "Mọi ảnh và clip của dự án, lọc theo nguồn; tải lên, dán link ảnh / video / trang video; kéo thả vào dòng thời gian.",
  panels: [{ id: "media", title: "Thư viện", icon: ImageIcon, order: 20, badge: (c) => (c.media.captures.length ? { count: c.media.captures.length, tone: "warn" } : null), Component: MediaPanel }],
  mediaSources: [
    { id: "scene", label: "Cho cảnh này", order: 0, match: (o, c) => o.sceneId === c.selection.sceneId },
    { id: "unused", label: "Chưa dùng", order: 1, match: (o, c) => !c.derived.usedKeys[o.key] },
    { id: "article", label: "Bài gốc", order: 10, match: (o) => o.provider === "article" },
    { id: "related", label: "Báo khác", order: 20, match: (o) => o.provider === "related" },
    { id: "webvideo", label: "Video web", order: 30, match: (o) => o.provider === "yt-dlp" || o.provider === "yt-capture" },
    { id: "stock", label: "Stock", order: 40, match: (o) => o.provider === "pexels" || o.provider === "pixabay" },
    { id: "ai", label: "Ảnh AI", order: 50, match: (o) => o.provider === "gemini_image" },
    { id: "upload", label: "Tải lên", order: 60, match: (o) => o.provider === "upload" || o.provider === "url" },
  ],
  commands: [{ id: "media.open", title: () => "Mở thư viện hình", group: "Đi tới", run: (c) => c.ui.setPanel("media") }],
});
