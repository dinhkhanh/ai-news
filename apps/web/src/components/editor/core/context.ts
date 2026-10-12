"use client";
import { createContext, useContext, useSyncExternalStore, type RefObject } from "react";
import type { PlayerRef } from "@remotion/player";
import type { MotionEngine } from "@ai-news/video/motion";
import type { FrameFaces } from "@/lib/media/framing";
import type { Issue } from "@/lib/media/editor-checks";
import type { RewriteMode } from "@/lib/llm/rewrite-modes";
import type { buildFromDoc, EditorDoc, EditorScene, EditorVisual } from "@/lib/media/editor";
import type { PendingCapture } from "@/lib/media/visual-plan";
import type { EditorProps, ExportInfo, VisualOption } from "../types";
import type { Contributions, EditorPlugin } from "./plugin";

export type Selection = { sceneId: string | null; shot: number };
export type EditorMode = "edit" | "deliver";
export type UpdateOpts = { coalesce?: string };
export type RegenerateWhat = "voice" | "broll" | "music" | "motion";
export type RegeneratePayload = { sceneId?: string; voiceover?: string; brollTerms?: string[]; engine?: MotionEngine; instruction?: string; shot?: number | null; backdrop?: { key: string; trimStartSec: number } | null };

/** Player position, kept outside React state so only the playhead and the transport re-render at 30 fps. */
export type TimeState = { frame: number; playing: boolean };
export type TimeStore = { get: () => TimeState; set: (patch: Partial<TimeState>) => void; subscribe: (fn: () => void) => () => void };

export function createTimeStore(): TimeStore {
  let state: TimeState = { frame: 0, playing: false };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const next = { ...state, ...patch };
      if (next.frame === state.frame && next.playing === state.playing) return;
      state = next;
      subs.forEach((f) => f());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export type PlayerApi = {
  ref: RefObject<PlayerRef | null>;
  fps: number;
  seek: (sec: number) => void;
  seekScene: (sceneId: string) => void;
  toggle: () => void;
  /** Current position in seconds (read on demand, not reactive). */
  nowSec: () => number;
};

export type EditorServices = {
  /** Save the document as a new version (the page then opens it). */
  save: () => void;
  /** Render the saved version, or save first and render the new one; one render per logo choice, back to back. */
  exportVideo: (logos: string[]) => void;
  forceRender: (render: ExportInfo["renders"][number]) => void;
  /** A background step on the latest saved version (new version when it finishes). */
  regenerate: (what: RegenerateWhat, payload?: RegeneratePayload) => void;
  /** Claude rewrites a scene's voice-over; the suggestion goes into the voice-over draft of that scene. */
  rewrite: (sceneId: string, mode: RewriteMode, instruction?: string) => Promise<void>;
  /** Restore the version being viewed as a new latest version. */
  restore: () => void;
  setPlugins: (disabled: string[]) => Promise<void>;
};

export type EditorCtx = {
  props: EditorProps;
  doc: EditorDoc;
  built: ReturnType<typeof buildFromDoc>;
  durationSec: number;
  /** One labelled, undoable change of the document (no-op when read-only). */
  update: (label: string, fn: (doc: EditorDoc) => EditorDoc, opts?: UpdateOpts) => void;
  updateScene: (sceneId: string, label: string, fn: (scene: EditorScene) => EditorScene, opts?: UpdateOpts) => void;
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null; undo: () => void; redo: () => void };
  dirty: boolean;
  /** Drop every unsaved change. */
  reset: () => void;
  readOnly: boolean;
  canSave: boolean;
  canRegenerate: boolean;
  regenerateHint: string | null;
  exportHint: string | null;
  /** Something is in flight (save, export, regenerate request, rewrite). */
  pending: { saving: boolean; exporting: boolean; rewriting: string | null; requesting: boolean };
  busy: boolean;
  selection: Selection;
  select: (patch: Partial<Selection>) => void;
  selectedScene: EditorScene | null;
  selectedIndex: number;
  player: PlayerApi;
  time: TimeStore;
  ui: {
    panel: string;
    /** Show a panel (and the panel column, when collapsed). */
    setPanel: (id: string) => void;
    /** Desktop: the panel column beside the rail is shown. */
    panelOpen: boolean;
    setPanelOpen: (open: boolean) => void;
    /** Desktop: the inspector column is shown (collapsed = a slim strip with a button to reopen it). */
    inspectorOpen: boolean;
    setInspectorOpen: (open: boolean) => void;
    tab: string;
    setTab: (id: string) => void;
    mode: EditorMode;
    setMode: (m: EditorMode) => void;
    overlays: Record<string, boolean>;
    toggleOverlay: (id: string) => void;
    paletteOpen: boolean;
    setPaletteOpen: (open: boolean) => void;
    /** Version note typed for the next save. */
    note: string;
    setNote: (note: string) => void;
    /** A comment pinned at this time is being written (set by the "comment here" command). */
    commentAtMs: number | null;
    setCommentAtMs: (ms: number | null) => void;
  };
  media: {
    options: VisualOption[];
    urls: Record<string, string>;
    addOption: (option: VisualOption, url: string) => void;
    frameOption: (assetId: string, frame: FrameFaces) => void;
    captures: PendingCapture[];
    addCapture: (c: PendingCapture) => void;
    placeCapture: (c: PendingCapture, option: VisualOption, url: string) => void;
    /** Put an option into a shot (keeps a hand-drawn look, crops a still by its faces). */
    place: (option: VisualOption, sceneId: string, shot: number) => void;
  };
  drafts: { voice: Record<string, string>; setVoice: (sceneId: string, text: string) => void };
  derived: {
    usedKeys: Record<string, string[]>;
    mixUsable: boolean;
    isAiStill: (v: { key: string }) => boolean;
    issues: Issue[];
    thumb: (v: EditorVisual) => { src: string | null; video: boolean };
  };
  plugins: { all: EditorPlugin[]; active: EditorPlugin[]; disabled: string[]; contributions: Contributions };
  applyFix: (issue: Issue) => void;
  services: EditorServices;
};

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside <EditorContext>");
  return ctx;
}

/** The player's ref, for the component that mounts the <Preview> (kept apart from the context object for the React compiler). */
export function usePlayerRef() {
  return useEditor().player.ref;
}

/** Player position, re-rendering the caller on every frame update. */
export function usePlayerTime(): TimeState {
  const { time } = useEditor();
  return useSyncExternalStore(time.subscribe, time.get, time.get);
}

/** True when keyboard focus is in a field, so single-key shortcuts leave the typing alone. */
export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}
