import "server-only";
import { NonRetriableError } from "inngest";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { autoAfterScript } from "@/inngest/auto-pipeline";
import { logActivity } from "@/lib/activity";
import { isPermanentLlmError, LlmOutputError } from "@/lib/llm/client";
import { checkFaithfulness } from "@/lib/llm/faithfulness";
import type { ArticleInput } from "@/lib/llm/prompt";
import type { StoredFaithfulness, StoredScript } from "@/lib/llm/schemas";
import { generateScript } from "@/lib/llm/script";
import { reportProgress } from "@/lib/progress";
import { eventSuperseded } from "@/lib/project-state";
import type { PipelineSteps } from "./steps";

export type ScriptRequest = {
  projectId: string;
  organizationId: string;
  requestedBy: string;
  durationSec: number;
  tone: string;
  /** Pin a template version (admin testing); default = promoted. */
  templateId?: string;
  /** When the queued event was sent (`event.ts`); an event older than the newest script version is dropped. Direct runs leave it out. */
  sentAt?: number;
};

/**
 * Pipeline step 2 (docs/PLAN.md §4.2): Opus 5 script from the confirmed article,
 * stored as a new script version, then the faithfulness pass. The project moves
 * to `scripted`; regenerating simply creates the next version. One body for both
 * runners, like `fetchPipeline`. Returns the auto-mode follow-up event, if any.
 */
export async function scriptPipeline(data: ScriptRequest, steps: PipelineSteps) {
  const { projectId, organizationId, requestedBy, durationSec, tone, templateId, sentAt } = data;
  const ctx = { userId: requestedBy, organizationId };
  const pctx = { ...ctx, projectId };

  const input = await steps.run("load-article", async () => {
    const row = await withOrgContext(ctx, async (tx) => {
      const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
      if (!project) throw new NonRetriableError("Project not found in this workspace");
      // Before anything is written: a direct run may hold the project right now, and its progress must stay intact.
      const latest = await tx.query.scripts.findFirst({ where: eq(schema.scripts.projectId, projectId), orderBy: desc(schema.scripts.createdAt), columns: { createdAt: true } });
      if (eventSuperseded(sentAt, { latestResultAt: latest?.createdAt, progress: project.busyProgress })) return null;
      const article = await tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) });
      if (!article) throw new NonRetriableError("No article on this project yet");
      if (!article.confirmedAt) throw new NonRetriableError("Confirm the article text before generating a script");
      await tx.update(schema.projects).set({ busyStep: "script", lastError: null, durationSec, tone }).where(eq(schema.projects.id, projectId));
      return { project, article };
    });
    if (!row) return null;
    await reportProgress(pctx, { label: "Đọc bài đã xác nhận", pct: 3 });
    const article: ArticleInput = {
      title: row.article.title,
      text: row.article.text,
      siteName: row.article.siteName,
      url: row.article.canonicalUrl,
      publishedAt: row.article.publishedAt ? row.article.publishedAt.toISOString() : null,
      kind: row.project.sourceKind,
    };
    return { article, language: row.project.language, articleId: row.article.id };
  });
  if (!input) return { next: null, result: { projectId, skipped: "superseded" as const } };

  const generated = await steps.run("generate-script", async () => {
    await reportProgress(pctx, { label: `Claude Opus 5 viết kịch bản ${durationSec} giây (${tone})`, pct: 8 });
    try {
      const r = await generateScript({ article: input.article, language: input.language, durationSec, tone, templateId }, { ...ctx, projectId });
      return { script: r.script, template: r.template, model: r.model, usage: r.usage, costUsd: r.costUsd };
    } catch (e) {
      // Refusals, billing, auth and schema errors do not fix themselves; fail fast so the UI can show the reason.
      if (isPermanentLlmError(e)) throw new NonRetriableError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  });

  const scriptRow = await steps.run("store-script", async () => {
    await reportProgress(pctx, { label: "Lưu kịch bản", pct: 60 });
    const [row] = await withOrgContext(ctx, async (tx) => {
      const latest = await tx.query.scripts.findFirst({ where: eq(schema.scripts.projectId, projectId), orderBy: desc(schema.scripts.version) });
      return tx
        .insert(schema.scripts)
        .values({
          organizationId,
          projectId,
          version: (latest?.version ?? 0) + 1,
          scenesJson: generated.script as unknown as Record<string, unknown>,
          templateId: generated.template.id,
          templateVersion: generated.template.version,
          model: generated.model,
          inputTokens: generated.usage.input_tokens + generated.usage.cache_creation_input_tokens + generated.usage.cache_read_input_tokens,
          outputTokens: generated.usage.output_tokens,
          costUsd: generated.costUsd.toFixed(4),
          createdBy: requestedBy,
        })
        .returning({ id: schema.scripts.id, version: schema.scripts.version });
    });
    return row;
  });

  const faithfulness = await steps.run("faithfulness", async (): Promise<StoredFaithfulness | null> => {
    await reportProgress(pctx, { label: "Kiểm chứng từng cảnh với bài gốc", pct: 65 });
    try {
      const { result } = await checkFaithfulness({ article: input.article, script: generated.script as StoredScript, language: input.language }, { ...ctx, projectId });
      return result;
    } catch (e) {
      if (e instanceof LlmOutputError || isPermanentLlmError(e)) return null; // stored as "unavailable"; the reviewer sees the warning
      throw e;
    }
  });

  await steps.run("finalise", async () => {
    await reportProgress(pctx, { label: "Hoàn tất", pct: 95 });
    await withOrgContext(ctx, async (tx) => {
      await tx
        .update(schema.scripts)
        .set({
          faithfulnessJson: (faithfulness ?? { error: "faithfulness check unavailable" }) as unknown as Record<string, unknown>,
          costUsd: (generated.costUsd + (faithfulness?.costUsd ?? 0)).toFixed(4),
        })
        .where(eq(schema.scripts.id, scriptRow.id));
      const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
      await tx
        .update(schema.projects)
        .set({
          state: "scripted",
          busyStep: null, busyProgress: null,
          lastError: null,
          sensitiveTopic: Boolean(project?.sensitiveTopic || generated.script.sensitiveTopic),
          title: project?.title ?? generated.script.title,
        })
        .where(eq(schema.projects.id, projectId));
    });
    await logActivity({
      actorId: requestedBy,
      organizationId,
      projectId,
      type: "script.generated",
      payload: {
        scriptId: scriptRow.id,
        version: scriptRow.version,
        model: generated.model,
        servedBy: generated.script.generation.servedBy,
        templateVersion: generated.template.version,
        durationSec,
        tone,
        scenes: generated.script.scenes.length,
        estimatedDurationSec: generated.script.estimatedDurationSec,
        costUsd: generated.costUsd + (faithfulness?.costUsd ?? 0),
        faithfulness: faithfulness?.counts ?? null,
      },
    });
  });

  const next = await steps.run("auto-continue", () => autoAfterScript(ctx, projectId, scriptRow.id));
  return { next, result: { scriptId: scriptRow.id, version: scriptRow.version, faithfulness: faithfulness?.counts ?? null, auto: Boolean(next) } };
}

export async function failScript(data: Pick<ScriptRequest, "projectId" | "organizationId" | "requestedBy">, message: string, direct = false) {
  const { projectId, organizationId, requestedBy } = data;
  await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
    tx.update(schema.projects).set({ busyStep: null, busyProgress: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
  );
  await logActivity({ actorId: requestedBy, organizationId, projectId, type: "script.failed", payload: { error: message.slice(0, 500), ...(direct ? { direct: true } : {}) } });
}
