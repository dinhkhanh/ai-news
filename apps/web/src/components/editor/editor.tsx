"use client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import type { PlayerRef } from "@remotion/player";
import type { Timeline } from "@ai-news/video/schema";
import { toast } from "sonner";
import { regenerateScene, saveTimeline } from "@/app/app/projects/[id]/edit/actions";
import { ReviewPanel } from "@/components/review-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { audioSignature, buildFromDoc, type EditorDoc, type EditorScene } from "@/lib/media/editor";
import { cn } from "@/lib/utils";
import { CommentsPanel } from "./comments-panel";
import { Preview } from "./preview";
import { SceneInspector } from "./scene-inspector";
import { SceneList } from "./scene-list";
import type { EditorProps } from "./types";

const FPS = 30;

/** Swap R2 keys for presigned URLs; anything without a URL falls back so the Player never requests a bare key. */
function resolveForPlayer(t: Timeline, urls: Record<string, string>): Timeline {
  const u = (k: string | null) => (k ? (urls[k] ?? null) : null);
  return {
    ...t,
    brand: { ...t.brand, logoSrc: u(t.brand.logoSrc) },
    scenes: t.scenes.map((s) => {
      const src = s.visual.kind === "solid" ? null : u(s.visual.src);
      return { ...s, voiceSrc: u(s.voiceSrc), visual: s.visual.kind === "solid" || !src ? { kind: "solid" as const } : { ...s.visual, src } };
    }),
    audio: { ...t.audio, mixSrc: u(t.audio.mixSrc), voiceSrc: u(t.audio.voiceSrc), musicSrc: u(t.audio.musicSrc) },
  };
}

const KIND_LABEL: Record<string, string> = { built: "dựng", edited: "sửa", regenerated: "tạo lại" };

export function Editor(props: EditorProps) {
  const router = useRouter();
  const playerRef = useRef<PlayerRef>(null);
  const [doc, setDoc] = useState<EditorDoc>(props.doc);
  const [selectedId, setSelectedId] = useState<string | null>(props.doc.scenes[0]?.id ?? null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const savedJson = useMemo(() => JSON.stringify(props.doc), [props.doc]);
  const dirty = JSON.stringify(doc) !== savedJson;
  const busy = Boolean(props.busyStep);
  const readOnly = !props.canEdit || !props.version.isLatest || busy;
  const mixUsable = Boolean(props.mix && props.mix.signature === audioSignature(doc));

  const built = useMemo(() => buildFromDoc(doc, mixUsable && props.mix ? { mixKey: props.mix.mixKey, voiceKey: null } : null), [doc, mixUsable, props.mix]);
  const playerTimeline = useMemo(() => resolveForPlayer(built.timeline, props.urls), [built.timeline, props.urls]);
  const timings = built.timings.map((t) => ({ id: t.id, atSec: t.atSec, durationMs: t.durationMs }));
  const selected = doc.scenes.find((s) => s.id === selectedId) ?? doc.scenes[0] ?? null;
  const selectedIndex = selected ? doc.scenes.findIndex((s) => s.id === selected.id) : -1;

  const seekToScene = useCallback(
    (id: string) => {
      const t = built.timings.find((x) => x.id === id);
      if (t) playerRef.current?.seekTo(t.fromFrame + 2);
    },
    [built.timings],
  );
  const currentMs = () => ((playerRef.current?.getCurrentFrame() ?? 0) / FPS) * 1000;

  const updateScene = (next: EditorScene) => setDoc((d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === next.id ? next : s)) }));
  const removeScene = (id: string) => {
    setDoc((d) => ({ ...d, scenes: d.scenes.filter((s) => s.id !== id) }));
    setSelectedId((cur) => (cur === id ? (doc.scenes.find((s) => s.id !== id)?.id ?? null) : cur));
  };

  const save = () => {
    if (!dirty || saving) return;
    setSaving(true);
    startTransition(async () => {
      const res = await saveTimeline({ projectId: props.projectId, baseVersion: props.version.version, doc, note: note || undefined });
      setSaving(false);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(res.message);
      router.push(`/app/projects/${props.projectId}/edit?t=${res.version}`);
      router.refresh();
    });
  };

  const restore = () => {
    const latest = props.versions[0];
    if (!latest || latest.id === props.version.id) return;
    startTransition(async () => {
      const res = await saveTimeline({ projectId: props.projectId, baseVersion: latest.version, doc: props.doc, note: `Khôi phục v${props.version.version}` });
      if (!res.ok) return void toast.error(res.message);
      toast.success(res.message);
      router.push(`/app/projects/${props.projectId}/edit?t=${res.version}`);
      router.refresh();
    });
  };

  const regenerate = (what: "voice" | "broll" | "music", payload: { sceneId?: string; voiceover?: string; brollTerms?: string[] } = {}) => {
    startTransition(async () => {
      const res = await regenerateScene({ projectId: props.projectId, timelineId: props.version.id, what, ...payload });
      if (!res.ok) return void toast.error(res.message);
      toast.success(res.message);
      router.push(`/app/projects/${props.projectId}/edit`);
      router.refresh();
    });
  };
  const regenerateHint = !props.canEdit ? "Vai trò của bạn chỉ được xem." : !props.version.isLatest ? "Chỉ tạo lại được trên phiên bản mới nhất." : busy ? `Đang chạy bước ${props.busyStep}…` : dirty ? "Lưu thay đổi trước khi tạo lại." : null;
  const canRegenerate = !regenerateHint;

  const thumb = (s: EditorScene) => {
    if (s.visual.kind === "solid") return { url: null, video: false };
    if (s.visual.thumbnailUrl) return { url: s.visual.thumbnailUrl, video: false };
    return { url: props.urls[s.visual.key] ?? null, video: s.visual.kind === "video" };
  };

  const coverFrame = doc.coverAtSec != null ? Math.round(doc.coverAtSec * FPS) : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)_380px]">
      {/* ---------------- preview + save ---------------- */}
      <div className="space-y-3">
        <Preview ref={playerRef} timeline={playerTimeline} width={340} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{(built.timeline.durationFrames / FPS).toFixed(1)} s</span>
          <span>· {doc.scenes.length} cảnh</span>
          <span>· {built.timeline.captions.length} phụ đề</span>
          {mixUsable ? <Badge variant="outline">âm thanh đã trộn</Badge> : <Badge variant="secondary">xem trước: lời + nhạc chưa trộn (lưu để trộn lại)</Badge>}
        </div>
        {props.lastError ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">{props.lastError}</p> : null}
        {busy ? <p className="text-xs text-muted-foreground">Đang chạy bước {props.busyStep}… trang tự làm mới khi xong.</p> : null}

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label>Ảnh bìa</Label>
            <span className="text-xs text-muted-foreground">{coverFrame != null ? `tại ${(coverFrame / FPS).toFixed(1)} s` : "tự động (~1,2 s)"}</span>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={() => setDoc((d) => ({ ...d, coverAtSec: Math.round(((playerRef.current?.getCurrentFrame() ?? 0) / FPS) * 10) / 10 }))}>
              Dùng khung hình hiện tại
            </Button>
            {coverFrame != null ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => playerRef.current?.seekTo(coverFrame)}>
                  xem
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={() => setDoc((d) => ({ ...d, coverAtSec: null }))}>
                  bỏ
                </Button>
              </>
            ) : null}
          </div>
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label>Nhạc nền</Label>
            <span className="text-xs text-muted-foreground">{doc.music ? `${doc.music.title} (${doc.music.source})` : "không"}</span>
          </div>
          <select
            value={doc.music?.key ?? ""}
            disabled={readOnly}
            onChange={(e) => {
              const key = e.target.value;
              if (!key) return setDoc((d) => ({ ...d, music: null }));
              if (doc.music && key === doc.music.key) return;
              const m = props.music.find((x) => x.key === key);
              if (m) setDoc((d) => ({ ...d, music: { key: m.key, gainDb: d.music?.gainDb ?? -12, attribution: `Nhạc: ${m.title}`, title: m.title, source: "library", licence: m.licence } }));
            }}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">— không nhạc —</option>
            {doc.music && !props.music.some((m) => m.key === doc.music!.key) ? <option value={doc.music.key}>{doc.music.title} (hiện tại)</option> : null}
            {props.music.map((m) => (
              <option key={m.id} value={m.key}>
                {m.title}
                {m.durationSec ? ` · ${m.durationSec.toFixed(0)} s` : ""}
                {m.moodTags.length ? ` · ${m.moodTags.slice(0, 3).join(", ")}` : ""}
              </option>
            ))}
          </select>
          {doc.music ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Âm lượng dưới lời</span>
              <input type="range" min={-24} max={-6} step={1} value={doc.music.gainDb} disabled={readOnly} onChange={(e) => setDoc((d) => (d.music ? { ...d, music: { ...d.music, gainDb: Number(e.target.value) } } : d))} className="flex-1" />
              <span className="w-12 text-right text-muted-foreground">{doc.music.gainDb} dB</span>
            </div>
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={!canRegenerate} onClick={() => regenerate("music")}>
            Nhạc mới (Mubert / thư viện)
          </Button>
        </div>

        {props.canEdit && props.version.isLatest ? (
          <div className="space-y-2 rounded-md border p-3">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú phiên bản (tuỳ chọn)" maxLength={200} className="h-8 w-full rounded-md border bg-background px-2 text-sm" disabled={!dirty} />
            <div className="flex items-center gap-2">
              <Button type="button" onClick={save} disabled={!dirty || saving || pending || busy}>
                {saving ? "Đang lưu…" : `Lưu thành v${props.version.version + 1}`}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setDoc(props.doc)}>
                Huỷ thay đổi
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Mỗi lần lưu là một phiên bản mới; đổi thứ tự, độ dài, lời hoặc nhạc sẽ trộn lại âm thanh (media Lambda, vài giây).
              {props.approvedTimelineId === props.version.id ? " Phiên bản này đã được duyệt: lưu sẽ huỷ duyệt." : ""}
            </p>
          </div>
        ) : !props.version.isLatest ? (
          <div className="space-y-2 rounded-md border p-3 text-xs">
            <p>Bạn đang xem phiên bản cũ (v{props.version.version}); chỉ đọc.</p>
            {props.canEdit ? (
              <Button type="button" size="sm" variant="outline" disabled={pending || busy} onClick={restore}>
                Khôi phục thành v{props.versions[0].version + 1}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---------------- track + inspector ---------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Cảnh</h2>
            <span className="text-xs text-muted-foreground">kéo để đổi thứ tự · bấm để sửa</span>
          </div>
          <SceneList scenes={doc.scenes} timings={timings} selectedId={selected?.id ?? null} verdicts={props.verdicts} thumb={thumb} disabled={readOnly} onSelect={(id) => { setSelectedId(id); seekToScene(id); }} onReorder={(scenes) => setDoc((d) => ({ ...d, scenes }))} />
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Chi tiết cảnh</h2>
          {selected ? (
            <SceneInspector
              key={selected.id}
              scene={selected}
              index={selectedIndex}
              total={doc.scenes.length}
              options={props.options}
              urls={props.urls}
              verdict={props.verdicts?.[selected.id] ?? null}
              disabled={readOnly}
              canRegenerate={canRegenerate}
              regenerateHint={regenerateHint}
              onChange={updateScene}
              onRemove={() => removeScene(selected.id)}
              onRegenerate={(what, payload) => regenerate(what, { sceneId: selected.id, ...payload })}
              onSeek={() => seekToScene(selected.id)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Chọn một cảnh.</p>
          )}
        </div>
      </div>

      {/* ---------------- review, comments, versions ---------------- */}
      <div className="space-y-4">
        <section className="space-y-2 rounded-md border p-3">
          <h2 className="text-sm font-semibold">Duyệt</h2>
          <ReviewPanel
            projectId={props.projectId}
            state={props.projectState}
            latestTimeline={props.versions[0] ? { id: props.versions[0].id, version: props.versions[0].version } : null}
            approvedTimelineId={props.approvedTimelineId}
            canEdit={props.canEdit}
            canApprove={props.canApprove}
            busy={busy || dirty}
            needsOverride={!props.faithfulnessCounts || props.faithfulnessCounts.unsupported + props.faithfulnessCounts.unchecked > 0}
            faithfulnessCounts={props.faithfulnessCounts}
            sensitiveTopic={props.sensitiveTopic}
            reviews={props.reviews}
          />
          {dirty ? <p className="text-[11px] text-amber-700 dark:text-amber-400">Lưu thay đổi trước khi gửi duyệt / duyệt.</p> : null}
          <Link href={`/app/projects/${props.projectId}`} className="text-xs underline">
            Về trang dự án (kết xuất, kịch bản, bài gốc)
          </Link>
        </section>
        <section className="space-y-2 rounded-md border p-3">
          <h2 className="text-sm font-semibold">Bình luận</h2>
          <CommentsPanel
            projectId={props.projectId}
            timelineId={props.version.id}
            comments={props.comments}
            canComment={props.canEdit}
            selectedSceneId={selected?.id ?? null}
            currentMs={currentMs}
            onJump={(atMs, sceneId) => {
              if (sceneId) setSelectedId(sceneId);
              if (atMs != null) playerRef.current?.seekTo(Math.round((atMs / 1000) * FPS));
              else if (sceneId) seekToScene(sceneId);
            }}
          />
        </section>
        <section className="space-y-2 rounded-md border p-3">
          <h2 className="text-sm font-semibold">Phiên bản</h2>
          <ul className="space-y-1 text-xs">
            {props.versions.map((v) => (
              <li key={v.id} className={cn("rounded px-1 py-0.5", v.id === props.version.id && "bg-muted")}>
                <Link href={`/app/projects/${props.projectId}/edit?t=${v.version}`} className="font-medium underline">
                  v{v.version}
                </Link>{" "}
                <span className="text-muted-foreground">
                  {KIND_LABEL[v.kind] ?? v.kind} · {v.createdAt.slice(0, 16).replace("T", " ")}
                  {v.createdByName ? ` · ${v.createdByName}` : ""}
                  {v.id === props.approvedTimelineId ? " · đã duyệt" : ""}
                </span>
                {v.changes.length ? <div className="text-muted-foreground">{v.changes.slice(0, 4).join(" · ")}{v.changes.length > 4 ? ` · +${v.changes.length - 4}` : ""}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
