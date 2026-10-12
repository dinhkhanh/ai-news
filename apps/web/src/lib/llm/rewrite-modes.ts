/** Voice-over rewrite modes (pure: the editor imports it; the call itself is `rewrite.ts`, server-only). */
export const REWRITE_MODES = ["shorter", "faithful", "custom"] as const;
export type RewriteMode = (typeof REWRITE_MODES)[number];
