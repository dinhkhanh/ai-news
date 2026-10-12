import type { OrgRole } from "@/lib/permissions";

/**
 * Editor plugin settings shared by the server actions and the editor page (pure, no server-only imports).
 * Plugin ids are kebab-case words with dots (`checks.shot-hold`); the list of plugins lives in
 * `components/editor/plugins`, the server only stores which ids a workspace switched off.
 */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;

/** Who may switch the workspace's editor plugins on and off: workspace admins / owners and platform admins. */
export function canManagePlugins(ws: { role: OrgRole; isAdmin: boolean }) {
  return ws.isAdmin || ws.role === "admin" || ws.role === "owner";
}

/** Disabled ids from a stored row, validated (anything malformed is ignored). */
export function disabledPlugins(row: { disabled: string[] } | null | undefined): string[] {
  return (row?.disabled ?? []).filter((id) => PLUGIN_ID_RE.test(id));
}
