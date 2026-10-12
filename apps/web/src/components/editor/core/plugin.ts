import type { ComponentType } from "react";
import type { Check } from "@/lib/media/editor-checks";
import type { VisualOption } from "../types";
import type { EditorCtx } from "./context";

/**
 * The editor's plugin contract. The core (`../editor.tsx` + `./context.ts`) owns the document, history,
 * selection, player and server services and renders nothing on its own; every panel, inspector tab,
 * timeline row, preview overlay, check, command, media filter and export target is contributed by a plugin
 * (`../plugins/*`), built-in ones included. Rules:
 * - Never mutate the document: call `ctx.update` / `ctx.updateScene` with a label; that is one undo step and
 *   feeds the unsaved badge. Server work goes through `ctx.services` (permission + busy checks in one place).
 * - Components read the context with `useEditor()`; functions (`when`, `run`, `badge`) get it as an argument.
 * - A workspace can switch a plugin off (`editor_plugin_settings`); `required` plugins cannot be.
 */

/** Left rail entry + its panel. */
export type PanelContribution = {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** Rail position, small first. */
  order: number;
  /** A count on the rail icon (open issues, unresolved comments). */
  badge?: (ctx: EditorCtx) => { count: number; tone: "warn" | "info" } | null;
  /** Show on the rail only when true (e.g. admins). */
  when?: (ctx: EditorCtx) => boolean;
  Component: ComponentType;
};

/** A tab of the inspector for the selected scene. */
export type InspectorContribution = {
  id: string;
  title: (ctx: EditorCtx) => string;
  order: number;
  when?: (ctx: EditorCtx) => boolean;
  Component: ComponentType;
};

/** Geometry the timeline hands its rows. */
export type TimelineLayout = { pxPerSec: number; durationSec: number; width: number; x: (sec: number) => number };

/** A row of the timeline. */
export type TrackContribution = {
  id: string;
  label: string;
  /** Row height in px. */
  height: number;
  order: number;
  when?: (ctx: EditorCtx) => boolean;
  Component: ComponentType<{ layout: TimelineLayout }>;
};

/** Pins on the timeline ruler (comments, the cover frame…). */
export type Marker = { id: string; atSec: number; label: string; tone: "accent" | "info" | "warn"; glyph?: string; onSelect?: () => void };
export type MarkerContribution = { id: string; items: (ctx: EditorCtx) => Marker[] };

/** A layer drawn over the preview, in a box the size of the 1080×1920 frame (use % or a 1080×1920 viewBox). */
export type OverlayContribution = { id: string; label: string; order: number; defaultOn: boolean; Component: ComponentType };

/** A palette / keyboard command. */
export type CommandContribution = {
  id: string;
  title: (ctx: EditorCtx) => string;
  group: "Sửa nhanh" | "Cảnh" | "Cả video" | "Đi tới" | "Tệp";
  /** Shortcut shown in the palette ("⌘S", "I"). */
  keys?: string;
  /** Keyboard trigger; `global` also fires while typing in a field (⌘S, ⌘K). */
  shortcut?: { match: (e: KeyboardEvent) => boolean; global?: boolean };
  when?: (ctx: EditorCtx) => boolean;
  run: (ctx: EditorCtx) => void;
};

/** A filter chip of the media library ("Bài gốc", "Stock", "Video web"…). */
export type MediaSourceContribution = { id: string; label: string; order: number; match: (o: VisualOption, ctx: EditorCtx) => boolean };

/** An export target block of the Deliver view. */
export type ExporterContribution = { id: string; label: string; order: number; Component: ComponentType };

export type EditorPlugin = {
  /** Stable id, stored when a workspace switches the plugin off (`PLUGIN_ID_RE`). */
  id: string;
  name: string;
  description: string;
  /** Part of the core experience: always on. */
  required?: boolean;
  panels?: PanelContribution[];
  inspector?: InspectorContribution[];
  tracks?: TrackContribution[];
  markers?: MarkerContribution[];
  overlays?: OverlayContribution[];
  checks?: Check[];
  commands?: CommandContribution[];
  mediaSources?: MediaSourceContribution[];
  exporters?: ExporterContribution[];
};

/** Identity helper so a plugin file reads as a declaration and is type-checked. */
export function definePlugin(plugin: EditorPlugin): EditorPlugin {
  return plugin;
}

export type Contributions = {
  panels: PanelContribution[];
  inspector: InspectorContribution[];
  tracks: TrackContribution[];
  markers: MarkerContribution[];
  overlays: OverlayContribution[];
  checks: Check[];
  commands: CommandContribution[];
  mediaSources: MediaSourceContribution[];
  exporters: ExporterContribution[];
};

/** The plugins that are on (required ones always), and their contributions sorted for display. */
export function collect(plugins: EditorPlugin[], disabled: string[]): { active: EditorPlugin[]; contributions: Contributions } {
  const off = new Set(disabled);
  const active = plugins.filter((p) => p.required || !off.has(p.id));
  const all = <K extends keyof Contributions>(k: K) => active.flatMap((p) => (p[k] ?? []) as Contributions[K][number][]);
  const byOrder = <T extends { order: number }>(xs: T[]) => [...xs].sort((a, b) => a.order - b.order);
  return {
    active,
    contributions: {
      panels: byOrder(all("panels")),
      inspector: byOrder(all("inspector")),
      tracks: byOrder(all("tracks")),
      markers: all("markers"),
      overlays: byOrder(all("overlays")),
      checks: all("checks"),
      commands: all("commands"),
      mediaSources: byOrder(all("mediaSources")),
      exporters: byOrder(all("exporters")),
    },
  };
}
