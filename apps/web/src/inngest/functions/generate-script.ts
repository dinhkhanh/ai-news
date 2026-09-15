import { NonRetriableError } from "inngest";
import { desc, eq } from "drizzle-orm";
import { inngest } from "../client";
import { projectScriptRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { isPermanentLlmError, LlmOutputError } from "@/lib/llm/client";
import { checkFaithfulness } from "@/lib/llm/faithfulness";
import type { ArticleInput } from "@/lib/llm/prompt";
import { generateScript } from "@/lib/llm/script";
import type { StoredFaithfulness, StoredScript } from "@/lib/llm/schemas";

/**
 * Pipeline step 2 (docs/PLAN.md §4.2): Opus 5 script from the confirmed article,
 * stored as a new script version, then the faithfulness pass. The project moves
 * to `scripted`; regenerating simply creates the next version.
 */
export const generateScriptFn = inngest.createFunction(
  {
    id: "generate-script",
    triggers: [projectScriptRequested],
    retries: 2,
    /** Global cap 5 = Inngest free-tier concurrency limit; per-project lock stays at 1. */
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 5 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "script generation failed";
      await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
        tx.update(schema.projects).set({ busyStep: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "script.failed", payload: { error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, durationSec, tone, templateId } = event.data;
    const ctx = { userId: requestedBy, organizationId };

    const input = await step.run("load-article", async () => {
      const row = await withOrgContext(ctx, async (tx) => {
        const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
        if (!project) throw new NonRetriableError("Project not found in this workspace");
        const article = await tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) });
        if (!article) throw new NonRetriableError("No article on this project yet");
        if (!article.confirmedAt) throw new NonRetriableError("Confirm the article text before generating a script");
        await tx.update(schema.projects).set({ busyStep: "script", lastError: null, durationSec, tone }).where(eq(schema.projects.id, projectId));
        return { project, article };
      });
      const article: ArticleInput = {
        title: row.article.title,
        text: row.article.text,
        siteName: row.article.siteName,
        url: row.article.canonicalUrl,
        publishedAt: row.article.publishedAt ? row.article.publishedAt.toISOString() : null,
      };
      return { article, language: row.project.language, articleId: row.article.id };
    });

    const generated = await step.run("generate-script", async () => {
      try {
        const r = await generateScript({ article: input.article, language: input.language, durationSec, tone, templateId }, { ...ctx, projectId });
        return { script: r.script, template: r.template, model: r.model, usage: r.usage, costUsd: r.costUsd };
      } catch (e) {
        // Refusals, billing, auth and schema errors do not fix themselves; fail fast so the UI can show the reason.
        if (isPermanentLlmError(e)) throw new NonRetriableError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    });

    const scriptRow = await step.run("store-script", async () => {
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

    const faithfulness = await step.run("faithfulness", async (): Promise<StoredFaithfulness | null> => {
      try {
        const { result } = await checkFaithfulness({ article: input.article, script: generated.script as StoredScript, language: input.language }, { ...ctx, projectId });
        return result;
      } catch (e) {
        if (e instanceof LlmOutputError || isPermanentLlmError(e)) return null; // stored as "unavailable"; the reviewer sees the warning
        throw e;
      }
    });

    await step.run("finalise", async () => {
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
            busyStep: null,
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

    return { scriptId: scriptRow.id, version: scriptRow.version, faithfulness: faithfulness?.counts ?? null };
  },
);
