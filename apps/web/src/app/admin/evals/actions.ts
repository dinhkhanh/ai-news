"use server";
import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { promptEvalRequested } from "@/inngest/events";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { countWords } from "@/lib/fetch/readability";
import { parsePreset } from "@/lib/presets";

const lines = (s: string) =>
  s
    .split(/\r?\n|;/)
    .map((x) => x.trim())
    .filter(Boolean);

export async function addEvalArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const language = str(fd, "language") === "en" ? "en" : "vi";
    const title = str(fd, "title");
    const text = String(fd.get("text") ?? "").trim();
    if (!title) throw new Error("Title is required");
    if (countWords(text) < 80) throw new Error("Eval articles need at least 80 words");
    const [row] = await db
      .insert(schema.evalArticles)
      .values({
        language,
        title,
        sourceUrl: str(fd, "sourceUrl") || null,
        text,
        notes: str(fd, "notes") || null,
        expectations: { mustMention: lines(str(fd, "mustMention")), mustNotMention: lines(str(fd, "mustNotMention")) },
        createdBy: session.user.id,
      })
      .returning({ id: schema.evalArticles.id });
    await log("admin.eval_article.added", { id: row.id, language, title });
    revalidatePath("/admin/evals");
    return `Added "${title}" to the ${language} eval set`;
  });
}

/** Copy a real project's confirmed article into the eval set (admin picks from /admin/evals). */
export async function importEvalArticleFromProject(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const projectId = str(fd, "projectId");
    const article = await withServiceContext((tx) =>
      tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) }),
    );
    if (!article) throw new Error("That project has no article");
    if (!article.language) throw new Error("Article language unknown");
    const [row] = await db
      .insert(schema.evalArticles)
      .values({
        language: article.language,
        title: article.title ?? article.canonicalUrl ?? "(untitled)",
        sourceUrl: article.canonicalUrl,
        text: article.text,
        notes: `Imported from project ${projectId}`,
        createdBy: session.user.id,
      })
      .returning({ id: schema.evalArticles.id });
    await log("admin.eval_article.added", { id: row.id, language: article.language, fromProject: projectId });
    revalidatePath("/admin/evals");
    return "Imported into the eval set";
  });
}

export async function toggleEvalArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const id = str(fd, "id");
    const enabled = fd.get("enabled") === "on";
    await db.update(schema.evalArticles).set({ enabled }).where(eq(schema.evalArticles.id, id));
    await log("admin.eval_article.toggled", { id, enabled });
    revalidatePath("/admin/evals");
    return enabled ? "Enabled" : "Disabled";
  });
}

export async function deleteEvalArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const id = str(fd, "id");
    await db.delete(schema.evalArticles).where(eq(schema.evalArticles.id, id));
    await log("admin.eval_article.removed", { id });
    revalidatePath("/admin/evals");
    return "Removed";
  });
}

/** Queue an eval run for a template version (script or faithfulness purpose). */
export async function runPromptEval(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const templateId = str(fd, "templateId");
    const template = await db.query.promptTemplates.findFirst({ where: eq(schema.promptTemplates.id, templateId) });
    if (!template) throw new Error("Template not found");
    if (template.purpose !== "script" && template.purpose !== "faithfulness") throw new Error("Evals run on script and faithfulness templates only");
    const { durationSec, tone } = parsePreset(fd);
    const running = await db.query.promptEvals.findFirst({ where: eq(schema.promptEvals.status, "running") });
    if (running) throw new Error("Another eval is still running; wait for it to finish");
    const [ev] = await db
      .insert(schema.promptEvals)
      .values({ templateId, durationSec, tone, requestedBy: session.user.id })
      .returning({ id: schema.promptEvals.id });
    await inngest.send(promptEvalRequested.create({ evalId: ev.id, requestedBy: session.user.id }));
    await log("admin.prompt.eval_requested", { evalId: ev.id, templateId, purpose: template.purpose, language: template.language, version: template.version, durationSec, tone });
    revalidatePath("/admin/prompts");
    revalidatePath("/admin/evals");
    return `Eval queued for ${template.purpose}/${template.language} v${template.version}`;
  });
}
