import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { PromptPurpose } from "@/lib/integrations";
import { defaultTemplate, type Language } from "@/lib/prompts/defaults";
import { renderTemplate, type TemplateVars } from "./render";

export type LoadedTemplate = { id: string | null; version: number; body: string; model: string | null; purpose: PromptPurpose; language: Language };

/** Promoted admin version, or the built-in default when nothing is promoted. */
export async function loadTemplate(purpose: PromptPurpose, language: Language, templateId?: string | null): Promise<LoadedTemplate> {
  const row = templateId
    ? await db.query.promptTemplates.findFirst({ where: eq(schema.promptTemplates.id, templateId) })
    : await db.query.promptTemplates.findFirst({
        where: and(eq(schema.promptTemplates.purpose, purpose), eq(schema.promptTemplates.language, language), eq(schema.promptTemplates.promoted, true)),
      });
  if (row) return { id: row.id, version: row.version, body: row.body, model: row.model, purpose, language };
  const d = defaultTemplate(purpose, language);
  if (!d) throw new Error(`No prompt template for ${purpose}/${language}`);
  return { id: null, version: 0, body: d.body, model: d.model, purpose, language };
}

export type ArticleInput = {
  title: string | null;
  text: string;
  siteName?: string | null;
  url?: string | null;
  publishedAt?: Date | string | null;
  /** What the text is (`projects.source_kind`); the script request says so (`sourceNote` in script.ts). Default `article`. */
  kind?: "article" | "video" | "text";
};

export function articleBlockText(a: ArticleInput) {
  const published = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : null;
  return [
    "<article>",
    `Title: ${a.title ?? "(untitled)"}`,
    a.siteName || a.url ? `Source: ${[a.siteName, a.url].filter(Boolean).join(" · ")}` : null,
    published ? `Published: ${published}` : null,
    "",
    a.text,
    "</article>",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * System blocks for a template + article. Both blocks carry cache_control so a
 * regenerate (same template, same article, different tone/duration) and the
 * faithfulness pass reuse the cached prefix. Volatile parameters go into the
 * user message, not here.
 */
export function buildSystem(template: LoadedTemplate, vars: TemplateVars, article: ArticleInput): Anthropic.TextBlockParam[] {
  const inline = /\{\{\s*article_text\s*\}\}/.test(template.body);
  const body = renderTemplate(template.body, { ...vars, article_text: inline ? article.text : "", article_title: article.title ?? "" });
  const blocks: Anthropic.TextBlockParam[] = [{ type: "text", text: body, cache_control: { type: "ephemeral" } }];
  if (!inline) blocks.push({ type: "text", text: articleBlockText(article), cache_control: { type: "ephemeral" } });
  return blocks;
}
