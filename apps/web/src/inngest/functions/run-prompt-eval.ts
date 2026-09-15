import { NonRetriableError } from "inngest";
import { and, eq } from "drizzle-orm";
import { inngest } from "../client";
import { promptEvalRequested } from "../events";
import { db, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { checkFaithfulness } from "@/lib/llm/faithfulness";
import { generateScript } from "@/lib/llm/script";
import { summarise, type EvalArticleResult } from "@/lib/eval-summary";
import type { Language } from "@/lib/prompts/defaults";

const norm = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * Admin eval run (docs/PLAN.md §9 "Quality"): generate a script for every
 * enabled eval article with the template version under test, run the
 * faithfulness pass, check expectations and store per-article results + a
 * summary on the eval row and the template.
 */
export const runPromptEvalFn = inngest.createFunction(
  {
    id: "run-prompt-eval",
    triggers: [promptEvalRequested],
    retries: 1,
    concurrency: { limit: 1 },
    onFailure: async ({ event }) => {
      const { evalId } = event.data.event.data;
      await db
        .update(schema.promptEvals)
        .set({ status: "failed", error: (event.data.error?.message ?? "eval failed").slice(0, 2000), finishedAt: new Date() })
        .where(eq(schema.promptEvals.id, evalId));
    },
  },
  async ({ event, step }) => {
    const { evalId, requestedBy } = event.data;

    const setup = await step.run("load", async () => {
      const ev = await db.query.promptEvals.findFirst({ where: eq(schema.promptEvals.id, evalId) });
      if (!ev) throw new NonRetriableError("Eval not found");
      const template = await db.query.promptTemplates.findFirst({ where: eq(schema.promptTemplates.id, ev.templateId) });
      if (!template) throw new NonRetriableError("Template not found");
      if (template.purpose !== "script" && template.purpose !== "faithfulness") throw new NonRetriableError(`Evals are only defined for script and faithfulness templates (got ${template.purpose})`);
      const articles = await db
        .select({ id: schema.evalArticles.id, title: schema.evalArticles.title, text: schema.evalArticles.text, sourceUrl: schema.evalArticles.sourceUrl, expectations: schema.evalArticles.expectations })
        .from(schema.evalArticles)
        .where(and(eq(schema.evalArticles.language, template.language), eq(schema.evalArticles.enabled, true)));
      if (articles.length === 0) throw new NonRetriableError(`No enabled eval articles for language ${template.language}; add some in /admin/evals`);
      await db.update(schema.promptEvals).set({ status: "running", articleCount: articles.length }).where(eq(schema.promptEvals.id, evalId));
      return { purpose: template.purpose as "script" | "faithfulness", language: template.language as Language, templateId: template.id, durationSec: ev.durationSec, tone: ev.tone, articles };
    });

    const ctx = { userId: requestedBy, organizationId: null, projectId: null };
    const results: EvalArticleResult[] = [];
    // Small batches keep the run inside the route's maxDuration per step while using some parallelism.
    const batchSize = 3;
    for (let i = 0; i < setup.articles.length; i += batchSize) {
      const batch = setup.articles.slice(i, i + batchSize);
      const out = await Promise.all(
        batch.map((a) =>
          step.run(`article-${a.id.slice(0, 8)}`, async (): Promise<EvalArticleResult> => {
            const t0 = Date.now();
            try {
              const article = { title: a.title, text: a.text, url: a.sourceUrl };
              const gen = await generateScript(
                { article, language: setup.language, durationSec: setup.durationSec, tone: setup.tone, templateId: setup.purpose === "script" ? setup.templateId : null },
                ctx,
              );
              const faith = await checkFaithfulness(
                { article, script: gen.script, language: setup.language, templateId: setup.purpose === "faithfulness" ? setup.templateId : null },
                ctx,
              );
              const allText = norm([gen.script.scenes.map((s) => `${s.voiceover} ${s.onScreenText}`).join(" "), gen.script.title].join(" "));
              const must = a.expectations.mustMention ?? [];
              const mustNot = a.expectations.mustNotMention ?? [];
              return {
                articleId: a.id,
                title: a.title,
                ok: true,
                scenes: gen.script.scenes.length,
                estimatedDurationSec: gen.script.estimatedDurationSec,
                durationDeviationPct: Math.round(((gen.script.estimatedDurationSec - setup.durationSec) / setup.durationSec) * 1000) / 10,
                supported: faith.result.counts.supported,
                partial: faith.result.counts.partial,
                unsupported: faith.result.counts.unsupported + faith.result.counts.unchecked,
                evidenceMissing: faith.result.scenes.filter((s) => s.verdict !== "supported" || (s.evidence && !faith.result.evidenceFound[s.sceneId])).length,
                expectationsMissed: must.filter((m) => !allText.includes(norm(m))),
                forbiddenMentioned: mustNot.filter((m) => allText.includes(norm(m))),
                scriptCostUsd: gen.costUsd,
                faithfulnessCostUsd: faith.result.costUsd,
                latencyMs: Date.now() - t0,
                scriptTitle: gen.script.title,
                hook: gen.script.scenes[0]?.voiceover,
              };
            } catch (e) {
              return { articleId: a.id, title: a.title, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500), latencyMs: Date.now() - t0 };
            }
          }),
        ),
      );
      results.push(...out);
    }

    await step.run("finalise", async () => {
      const summary = summarise(results);
      await db
        .update(schema.promptEvals)
        .set({ status: "done", results: results as unknown as Array<Record<string, unknown>>, summary, costUsd: summary.totalCostUsd.toFixed(4), finishedAt: new Date() })
        .where(eq(schema.promptEvals.id, evalId));
      await db
        .update(schema.promptTemplates)
        .set({ evalJson: { ...summary, evalId, at: new Date().toISOString() } })
        .where(eq(schema.promptTemplates.id, setup.templateId));
      await logActivity({ actorId: requestedBy, type: "admin.prompt.eval_completed", payload: { evalId, templateId: setup.templateId, ...summary } });
    });

    return { evalId, articles: results.length, failed: results.filter((r) => !r.ok).length };
  },
);
