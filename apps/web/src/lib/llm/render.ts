/** Placeholder substitution for prompt templates. Pure; unit-tested. */
export type TemplateVars = Record<string, string | number | null | undefined>;

export function renderTemplate(body: string, vars: TemplateVars) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key: string) => {
    const v = vars[key];
    if (v === undefined) return m; // unknown placeholder: leave visible so admins notice
    return v === null ? "" : String(v);
  });
}

export function placeholdersIn(body: string) {
  return Array.from(new Set(Array.from(body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g), (m) => m[1])));
}

export const KNOWN_PLACEHOLDERS = ["language", "duration_sec", "tone", "tone_guidance", "article_text", "article_title"] as const;
