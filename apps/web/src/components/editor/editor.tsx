"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PlayerRef } from "@remotion/player";
import type { Timeline } from "@ai-news/video/schema";
import { toast } from "sonner";
import { regenerateScene, renderTimeline, rewriteSceneVoiceover, saveTimeline, setEditorPlugins } from "@/app/app/projects/[id]/edit/actions";
import { audioSignature, buildFromDoc, replaceTailShots, sceneShots, setShot, type EditorDoc, type EditorVisual } from "@/lib/media/editor";
import { autoFrameShot, fillMissingShots, replaceWithUnused, runChecks, sceneZones, usedKeys as computeUsedKeys, visualFromOption, type Issue } from "@/lib/media/editor-checks";
import { commit, initHistory, redo, redoLabel, undo, undoLabel } from "@/lib/media/editor-history";
import { frameStill } from "@/lib/media/framing";
import { SHOT_SEC, type PendingCapture } from "@/lib/media/visual-plan";
import type { RewriteMode } from "@/lib/llm/rewrite-modes";
import { createTimeStore, EditorContext, isTyping, type EditorCtx, type EditorMode, type RegeneratePayload, type RegenerateWhat, type Selection } from "./core/context";
import { collect } from "./core/plugin";
import { BUILTIN_PLUGINS } from "./plugins";
import { Workspace } from "./shell/workspace";
import type { EditorProps, VisualOption } from "./types";

const FPS = 30;

/** Swap R2 keys for presigned URLs; anything without a URL falls back so the Player never requests a bare key. */
function resolveForPlayer(t: Timeline, urls: Record<string, string>, logoUrl: string | null): Timeline {
  const u = (k: string | null) => (k ? (urls[k] ?? null) : null);
  return {
    ...t,
    brand: { ...t.brand, logoSrc: logoUrl ?? u(t.brand.logoSrc), overlaySrc: u(t.brand.overlaySrc) },
    scenes: t.scenes.map((s) => {
      const visual = (v: Timeline["scenes"][number]["visual"]) => {
        if (v.kind === "solid") return v;
        // Motion graphics: their pictures and backdrop clip by URL; one that has no URL (yet) is left out of the preview.
        if (v.kind === "motion" || v.kind === "hyperframes") {
          const backdropSrc = v.backdrop ? u(v.backdrop.src) : null;
          return { ...v, images: (v.images ?? []).map((k) => u(k) ?? ""), backdrop: v.backdrop && backdropSrc ? { ...v.backdrop, src: backdropSrc } : null };
        }
        const src = u(v.src);
        return src ? { ...v, src } : { kind: "solid" as const };
      };
      return { ...s, voiceSrc: u(s.voiceSrc), visual: visual(s.visual), shots: s.shots.map((sh) => ({ ...sh, visual: visual(sh.visual) })) };
    }),
    audio: { ...t.audio, mixSrc: u(t.audio.mixSrc), voiceSrc: u(t.audio.voiceSrc), musicSrc: u(t.audio.musicSrc) },
  };
}

/** Which panel / inspector tab the editor opened with last time (per browser; a convenience only). */
const PREFS_KEY = "ai-news.editor.prefs";
type Prefs = { panel: string; tab: string; overlays: Record<string, boolean>; panelOpen: boolean; inspectorOpen: boolean };
function readPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function writePrefs(p: Prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: nothing to remember */
  }
}

/**
 * The editor core: owns the document (with undo history), the selection, the player and the server
 * services, collects the plugins that are on for this workspace and hands everything to them through
 * `EditorContext`. The layout is `shell/workspace.tsx`; every feature is a plugin in `plugins/`.
 */
export function Editor(props: EditorProps) {
  const router = useRouter();
  const playerRef = useRef<PlayerRef>(null);
  const [time] = useState(createTimeStore);
  const [hist, setHist] = useState(() => initHistory<EditorDoc>(props.doc));
  const doc = hist.present;
  const [selection, setSelection] = useState<Selection>({ sceneId: props.doc.scenes[0]?.id ?? null, shot: 0 });
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [options, setOptions] = useState<VisualOption[]>(props.options);
  const [urls, setUrls] = useState<Record<string, string>>(props.urls);
  const [captures, setCaptures] = useState<PendingCapture[]>(props.captures);
  const [voiceDrafts, setVoiceDrafts] = useState<Record<string, string>>({});
  const [disabled, setDisabled] = useState<string[]>(props.plugins.disabled);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [commentAtMs, setCommentAtMs] = useState<number | null>(null);
  // Which panel / tab / overlays the editor opened with last time (the editor only runs in the browser).
  const [panel, setPanelState] = useState(() => readPrefs().panel ?? "scenes");
  const [tab, setTabState] = useState(() => readPrefs().tab ?? "content");
  const [overlays, setOverlays] = useState<Record<string, boolean>>(() => {
    const saved = readPrefs().overlays ?? {};
    return Object.fromEntries(collect(BUILTIN_PLUGINS, props.plugins.disabled).contributions.overlays.map((o) => [o.id, saved[o.id] ?? o.defaultOn]));
  });

  const { active, contributions } = useMemo(() => collect(BUILTIN_PLUGINS, disabled), [disabled]);
  // Desktop: the panel beside the rail and the inspector can each be collapsed to give the preview room.
  const [panelOpen, setPanelOpen] = useState(() => readPrefs().panelOpen ?? true);
  const [inspectorOpen, setInspectorOpen] = useState(() => readPrefs().inspectorOpen ?? true);
  useEffect(() => writePrefs({ panel, tab, overlays, panelOpen, inspectorOpen }), [panel, tab, overlays, panelOpen, inspectorOpen]);

  const savedJson = useMemo(() => JSON.stringify(props.doc), [props.doc]);
  const dirty = useMemo(() => JSON.stringify(doc) !== savedJson, [doc, savedJson]);
  const busy = Boolean(props.busyStep);
  const readOnly = !props.canEdit || !props.version.isLatest || busy;
  const canSave = props.canEdit && props.version.isLatest;
  const mixUsable = Boolean(props.mix && props.mix.signature === audioSignature(doc));

  const built = useMemo(() => buildFromDoc(doc, mixUsable && props.mix ? { mixKey: props.mix.mixKey, voiceKey: null } : null), [doc, mixUsable, props.mix]);
  const usedKeys = useMemo(() => computeUsedKeys(doc), [doc]);
  const isAiStill = useCallback((v: { key: string }) => options.some((o) => o.key === v.key && o.provider === "gemini_image"), [options]);
  const hasLogo = Boolean(doc.brand.logoSrc || props.previewLogo);

  /* ------------------------------------------------------------ document */

  const update = useCallback<EditorCtx["update"]>(
    (label, fn, opts) => {
      if (readOnly) return;
      setHist((h) => commit(h, fn(h.present), label, { coalesce: opts?.coalesce }));
    },
    [readOnly],
  );
  const updateScene = useCallback<EditorCtx["updateScene"]>(
    (sceneId, label, fn, opts) => update(label, (d) => ({ ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? fn(s) : s)) }), opts),
    [update],
  );
  const reset = useCallback(() => setHist((h) => commit(h, props.doc, "Huỷ mọi thay đổi")), [props.doc]);

  /* ------------------------------------------------------------ selection + player */

  const selectedScene = doc.scenes.find((s) => s.id === selection.sceneId) ?? doc.scenes[0] ?? null;
  const selectedIndex = selectedScene ? doc.scenes.findIndex((s) => s.id === selectedScene.id) : -1;
  const timingsRef = useRef(built.timings);
  timingsRef.current = built.timings;

  const player = useMemo<EditorCtx["player"]>(
    () => ({
      ref: playerRef,
      fps: FPS,
      seek: (sec) => playerRef.current?.seekTo(Math.max(0, Math.round(sec * FPS))),
      seekScene: (id) => {
        const t = timingsRef.current.find((x) => x.id === id);
        if (t) playerRef.current?.seekTo(t.fromFrame + 2);
      },
      toggle: () => playerRef.current?.toggle(),
      nowSec: () => (playerRef.current?.getCurrentFrame() ?? time.get().frame) / FPS,
    }),
    [time],
  );
  const select = useCallback((patch: Partial<Selection>) => {
    setSelection((cur) => {
      const next = { ...cur, ...patch };
      if (patch.sceneId !== undefined && patch.sceneId !== cur.sceneId && patch.shot === undefined) next.shot = 0;
      return next;
    });
  }, []);

  /* ------------------------------------------------------------ media */

  const addOption = useCallback((o: VisualOption, url: string) => {
    setOptions((list) => [o, ...list.filter((x) => x.assetId !== o.assetId)]);
    setUrls((u) => ({ ...u, [o.key]: url }));
  }, []);
  const frameOption = useCallback((assetId: string, frame: VisualOption["frame"]) => setOptions((list) => list.map((o) => (o.assetId === assetId ? { ...o, frame } : o))), []);
  const addCapture = useCallback((c: PendingCapture) => setCaptures((list) => [...list.filter((x) => x.videoId !== c.videoId), c]), []);

  // A YouTube section recorded in this browser: one clip, cut into the 5 s segments the build had planned, placed at the tail of those scenes.
  const placeCapture = useCallback(
    (c: PendingCapture, o: VisualOption, url: string) => {
      addOption(o, url);
      setCaptures((list) => list.filter((x) => x.videoId !== c.videoId));
      const clip = (trimStartSec: number, clipDurationSec: number): EditorVisual => ({ kind: "video", key: o.key, clipDurationSec, trimStartSec, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl });
      if (c.manual) {
        const { sceneId, shot } = c.manual;
        updateScene(sceneId, `${sceneId}: clip YouTube đã ghi`, (s) => setShot(s, Math.min(shot, sceneShots(s).length - 1), clip(0, o.durationSec ?? c.segments * SHOT_SEC)));
        toast.success(`Đã ghi "${c.title.slice(0, 40)}" vào cảnh ${sceneId}. Xem lại rồi bấm Lưu.`);
        return;
      }
      const usable = Math.floor((o.durationSec ?? c.segments * SHOT_SEC) / SHOT_SEC);
      update("Đặt clip YouTube đã ghi", (d) => {
        let segment = 0;
        return {
          ...d,
          scenes: d.scenes.map((s) => {
            const plan = c.scenes.find((x) => x.sceneId === s.id);
            if (!plan) return s;
            const visuals: EditorVisual[] = [];
            for (let i = 0; i < plan.segments && segment < usable; i++, segment++) visuals.push(clip(segment * SHOT_SEC, SHOT_SEC));
            return visuals.length ? replaceTailShots(s, visuals) : s;
          }),
        };
      });
      toast.success(`Đã ghi "${c.title.slice(0, 40)}" và đặt vào ${c.scenes.map((x) => x.sceneId).join(", ")}. Xem lại rồi bấm Lưu.`);
    },
    [addOption, update, updateScene],
  );

  const place = useCallback(
    (o: VisualOption, sceneId: string, shot: number) => {
      updateScene(sceneId, `${sceneId}: đổi hình ${shot + 1}`, (s) => {
        const current = sceneShots(s)[shot];
        let next = visualFromOption(o);
        // A new picture in a hand-drawn shot is drawn too: the look belongs to the shot, not to the file.
        if (next.kind === "image" && current?.kind === "image" && current.sketch) next = { ...next, sketch: current.sketch };
        if (next.kind === "image" && o.frame) {
          const f = frameStill(o.frame, sceneZones(doc, s, hasLogo));
          next = { ...next, focus: f.focus, kenBurns: f.focus ? next.kenBurns && f.kenBurns : next.kenBurns };
        }
        return setShot(s, Math.min(shot, sceneShots(s).length - 1), next);
      });
      select({ sceneId, shot });
    },
    [doc, hasLogo, select, updateScene],
  );

  const thumb = useCallback((v: EditorVisual) => (v.kind !== "video" && v.kind !== "image" ? { src: null, video: false } : v.thumbnailUrl ? { src: v.thumbnailUrl, video: false } : { src: urls[v.key] ?? null, video: v.kind === "video" }), [urls]);

  /* ------------------------------------------------------------ checks */

  const platforms = useMemo(() => [...new Set(props.exportInfo.logoChannels.map((c) => c.platform))], [props.exportInfo.logoChannels]);
  const issues = useMemo(
    () => runChecks(contributions.checks, { doc, options, verdicts: props.verdicts, mixUsable, durationSec: built.durationSec, platforms, hasLogo, comic: props.comic }),
    [contributions.checks, doc, options, props.verdicts, mixUsable, built.durationSec, platforms, hasLogo, props.comic],
  );

  /* ------------------------------------------------------------ services */

  const regenerateHint = !props.canEdit ? "Vai trò của bạn chỉ được xem." : !props.version.isLatest ? "Chỉ tạo lại được trên phiên bản mới nhất." : busy ? `Đang chạy bước ${props.busyStep}…` : dirty ? "Lưu thay đổi trước khi tạo lại." : null;
  const exportHint = !props.canEdit ? "Vai trò của bạn chỉ được xem." : busy ? `Đang chạy bước ${props.busyStep}…` : dirty && !props.version.isLatest ? "Phiên bản cũ chỉ đọc: huỷ thay đổi để kết xuất nguyên bản này." : null;

  const openVersion = useCallback((v: number) => {
    router.push(`/app/projects/${props.projectId}/edit?t=${v}`);
    router.refresh();
  }, [router, props.projectId]);

  const save = useCallback(() => {
    if (!dirty || saving || !canSave || busy) return;
    setSaving(true);
    startTransition(async () => {
      const res = await saveTimeline({ projectId: props.projectId, baseVersion: props.version.version, doc, note: note || undefined });
      setSaving(false);
      if (!res.ok) return void toast.error(res.message);
      toast.success(res.message);
      if (res.version != null) openVersion(res.version);
    });
  }, [dirty, saving, canSave, busy, props.projectId, props.version.version, doc, note, openVersion]);

  const exportVideo = useCallback(
    (logos: string[]) => {
      if (exporting || saving || exportHint) return;
      setExporting(true);
      startTransition(async () => {
        let timelineId = props.version.id;
        let version = props.version.version;
        if (dirty) {
          const saved = await saveTimeline({ projectId: props.projectId, baseVersion: props.version.version, doc, note: note || undefined });
          if (!saved.ok || !saved.timelineId || saved.version == null) {
            setExporting(false);
            return void toast.error(saved.message);
          }
          toast.success(saved.message);
          timelineId = saved.timelineId;
          version = saved.version;
        }
        const res = await renderTimeline({ projectId: props.projectId, timelineId, logoChannelIds: logos.length ? logos : undefined });
        setExporting(false);
        if (res.ok) toast.success(res.message);
        else toast.error(version !== props.version.version ? `Đã lưu v${version} nhưng chưa kết xuất được: ${res.message}` : res.message);
        // A save made a new version: open it (the editor is keyed by version). Otherwise reload in place for the busy state.
        if (version !== props.version.version) openVersion(version);
        else router.refresh();
      });
    },
    [exporting, saving, exportHint, props.version.id, props.version.version, props.projectId, dirty, doc, note, openVersion, router],
  );

  const forceRender = useCallback<EditorCtx["services"]["forceRender"]>(
    (r) => {
      if (exporting || !r.timelineId) return;
      setExporting(true);
      startTransition(async () => {
        const res = await renderTimeline({ projectId: props.projectId, timelineId: r.timelineId!, logoChannelId: r.logoChannelId ?? "kit", skipQa: true });
        setExporting(false);
        (res.ok ? toast.success : toast.error)(res.message);
        router.refresh();
      });
    },
    [exporting, props.projectId, router],
  );

  const regenerate = useCallback(
    (what: RegenerateWhat, payload: RegeneratePayload = {}) => {
      if (regenerateHint) return void toast.error(regenerateHint);
      setRequesting(true);
      startTransition(async () => {
        const res = await regenerateScene({ projectId: props.projectId, timelineId: props.version.id, what, ...payload });
        setRequesting(false);
        if (!res.ok) return void toast.error(res.message);
        toast.success(res.message);
        router.push(`/app/projects/${props.projectId}/edit`);
        router.refresh();
      });
    },
    [regenerateHint, props.projectId, props.version.id, router],
  );

  const rewrite = useCallback(
    async (sceneId: string, rewriteMode: RewriteMode, instruction?: string) => {
      const scene = doc.scenes.find((s) => s.id === sceneId);
      if (!scene || rewriting || !props.canEdit) return;
      setRewriting(sceneId);
      try {
        const res = await rewriteSceneVoiceover({ projectId: props.projectId, timelineId: props.version.id, sceneId, voiceover: voiceDrafts[sceneId] ?? scene.voiceover, mode: rewriteMode, instruction });
        if (!res.ok) return void toast.error(res.message);
        setVoiceDrafts((d) => ({ ...d, [sceneId]: res.voiceover }));
        toast.success(`${sceneId}: ${res.message}`, { description: "Lời mới nằm trong ô Lời đọc. Bấm “Đọc lại giọng” để dùng." });
      } finally {
        setRewriting(null);
      }
    },
    [doc.scenes, rewriting, props.canEdit, props.projectId, props.version.id, voiceDrafts],
  );

  const restore = useCallback(() => {
    const latest = props.versions[0];
    if (!latest || latest.id === props.version.id) return;
    startTransition(async () => {
      const res = await saveTimeline({ projectId: props.projectId, baseVersion: latest.version, doc: props.doc, note: `Khôi phục v${props.version.version}` });
      if (!res.ok) return void toast.error(res.message);
      toast.success(res.message);
      if (res.version != null) openVersion(res.version);
    });
  }, [props.versions, props.version.id, props.version.version, props.projectId, props.doc, openVersion]);

  const setPlugins = useCallback(async (next: string[]) => {
    const prev = disabled;
    setDisabled(next);
    const res = await setEditorPlugins({ disabled: next });
    if (!res.ok) {
      setDisabled(prev);
      toast.error(res.message);
    } else toast.success(res.message);
  }, [disabled]);

  /* ------------------------------------------------------------ fixes */

  const applyFix = useCallback(
    (issue: Issue) => {
      const fix = issue.fix;
      if (!fix) return;
      const goTo = (sceneId: string, tabId: string, shot = 0) => {
        select({ sceneId, shot });
        setTabState(tabId);
        setInspectorOpen(true);
        player.seekScene(sceneId);
      };
      if (fix.kind === "open") return goTo(fix.sceneId, fix.tab, fix.shot ?? 0);
      if (fix.kind === "rewrite") {
        goTo(fix.sceneId, "content");
        return void rewrite(fix.sceneId, "faithful");
      }
      if (readOnly) return void toast.error(regenerateHint ?? "Phiên bản này chỉ đọc");
      const scene =
        fix.kind === "add-shots" ? fillMissingShots(doc, options, fix.sceneId) : fix.kind === "replace-shot" ? replaceWithUnused(doc, options, fix.sceneId, fix.shot) : autoFrameShot(doc, options, fix.sceneId, fix.shot, hasLogo);
      if (!scene) {
        goTo(fix.sceneId, "shots", "shot" in fix ? fix.shot : 0);
        return void toast.warning("Kho của dự án không còn hình chưa dùng: tải lên hoặc dán link trong Thư viện.");
      }
      updateScene(fix.sceneId, `${fix.sceneId}: ${fix.label.toLowerCase()}`, () => scene);
      goTo(fix.sceneId, "shots", "shot" in fix ? fix.shot : sceneShots(scene).length - 1);
      toast.success(`${fix.label}: xong. Xem lại rồi bấm Lưu.`);
    },
    [select, player, rewrite, readOnly, regenerateHint, doc, options, hasLogo, updateScene],
  );

  /* ------------------------------------------------------------ context */

  const ctx: EditorCtx = {
    props,
    doc,
    built,
    durationSec: built.durationSec,
    update,
    updateScene,
    history: { canUndo: hist.past.length > 0 && !readOnly, canRedo: hist.future.length > 0 && !readOnly, undoLabel: undoLabel(hist), redoLabel: redoLabel(hist), undo: () => !readOnly && setHist(undo), redo: () => !readOnly && setHist(redo) },
    dirty,
    reset,
    readOnly,
    canSave,
    canRegenerate: !regenerateHint && !pending,
    regenerateHint,
    exportHint,
    pending: { saving, exporting, rewriting, requesting: requesting || pending },
    busy,
    selection: { sceneId: selectedScene?.id ?? null, shot: selectedScene ? Math.min(selection.shot, sceneShots(selectedScene).length - 1) : 0 },
    select,
    selectedScene,
    selectedIndex,
    player,
    time,
    ui: {
      panel,
      // Opening a panel (rail, a command, a fix) also shows it when the panel column was collapsed.
      setPanel: (id) => {
        setPanelState(id);
        setPanelOpen(true);
      },
      panelOpen,
      setPanelOpen,
      inspectorOpen,
      setInspectorOpen,
      tab,
      setTab: (id) => {
        setTabState(id);
        setInspectorOpen(true);
      },
      mode,
      setMode,
      overlays,
      toggleOverlay: (id) => setOverlays((o) => ({ ...o, [id]: !o[id] })),
      paletteOpen,
      setPaletteOpen,
      note,
      setNote,
      commentAtMs,
      setCommentAtMs,
    },
    media: { options, urls, addOption, frameOption, captures, addCapture, placeCapture, place },
    drafts: { voice: voiceDrafts, setVoice: (sceneId, text) => setVoiceDrafts((d) => ({ ...d, [sceneId]: text })) },
    derived: { usedKeys, mixUsable, isAiStill, issues, thumb },
    plugins: { all: BUILTIN_PLUGINS, active, disabled, contributions },
    applyFix,
    services: { save, exportVideo, forceRender, regenerate, rewrite, restore, setPlugins },
  };

  // Keyboard: every command with a shortcut, from any plugin.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ctxRef.current;
      if (c.ui.paletteOpen) return;
      // Digits open the rail's panels in order (the rail's tooltips say which).
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e) && c.ui.mode === "edit") {
        const panelsShown = c.plugins.contributions.panels.filter((p) => !p.when || p.when(c));
        const target = panelsShown[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          c.ui.setPanel(target.id);
        }
        return;
      }
      for (const cmd of c.plugins.contributions.commands) {
        if (!cmd.shortcut || !cmd.shortcut.match(e)) continue;
        if (!cmd.shortcut.global && isTyping(e)) continue;
        if (cmd.when && !cmd.when(c)) continue;
        e.preventDefault();
        cmd.run(c);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const playerTimeline = useMemo(() => resolveForPlayer(built.timeline, urls, props.previewLogo?.url ?? null), [built.timeline, urls, props.previewLogo]);

  return (
    <EditorContext.Provider value={ctx}>
      <Workspace timeline={playerTimeline} />
    </EditorContext.Provider>
  );
}

