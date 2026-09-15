import { NonRetriableError } from "inngest";
import { eq } from "drizzle-orm";
import { inngest } from "../client";
import { projectFetchRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { heuristicLanguage } from "@/lib/language";
import { fetchArticle, manualArticle, type FetchAttempt, type FetchMethod } from "@/lib/fetch";
import { classifyArticle } from "@/lib/llm/classify";
import { putObject, r2Key } from "@/lib/r2";
import { canonicalizeUrl } from "@/lib/url";

/**
 * Pipeline step 1 (docs/PLAN.md §4.1): extract the article, snapshot it to R2,
 * detect language + sensitive topic, store the article row and move the project
 * to `fetched`. Failures leave the project in `failed` with last_error so the UI
 * can offer a re-fetch or manual paste.
 */
export const fetchArticleFn = inngest.createFunction(
  {
    id: "fetch-article",
    triggers: [projectFetchRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 10 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "fetch failed";
      await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
        tx.update(schema.projects).set({ busyStep: null, state: "failed", lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "article.fetch_failed", payload: { error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, method, manual } = event.data;
    const ctx = { userId: requestedBy, organizationId };

    const project = await step.run("load-project", async () => {
      const row = await withOrgContext(ctx, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }));
      if (!row) throw new NonRetriableError("Project not found in this workspace");
      await withOrgContext(ctx, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", lastError: null }).where(eq(schema.projects.id, projectId)));
      return { id: row.id, url: row.url, language: row.language };
    });

    const fetched = await step.run("extract", async () => {
      if (manual) {
        return { method: "manual" as FetchMethod, extracted: manualArticle({ ...manual, url: project.url }), rawHtml: null, screenshotB64: null, attempts: [] as FetchAttempt[] };
      }
      try {
        const out = await fetchArticle(project.url, { preferred: method });
        return { method: out.method, extracted: out.extracted, rawHtml: out.rawHtml, screenshotB64: out.screenshot?.toString("base64") ?? null, attempts: out.attempts };
      } catch (e) {
        // Every provider failed: not worth retrying automatically; the user picks a fallback.
        throw new NonRetriableError(e instanceof Error ? e.message : String(e));
      }
    });

    const snapshot = await step.run("snapshot-to-r2", async () => {
      const out: { snapshotPath: string | null; screenshotPath: string | null } = { snapshotPath: null, screenshotPath: null };
      try {
        if (fetched.rawHtml) out.snapshotPath = await putObject(r2Key.article(organizationId, projectId, "snapshot.html"), fetched.rawHtml, "text/html; charset=utf-8");
        if (fetched.screenshotB64) out.screenshotPath = await putObject(r2Key.article(organizationId, projectId, "screenshot.jpg"), Buffer.from(fetched.screenshotB64, "base64"), "image/jpeg");
      } catch (e) {
        // Snapshots are nice-to-have; the article text is what matters.
        console.warn("[fetch-article] snapshot upload failed", e);
      }
      return out;
    });

    const classification = await step.run("classify", async () => {
      const { extracted } = fetched;
      try {
        const c = await classifyArticle({ title: extracted.title, text: extracted.text }, { ...ctx, projectId });
        return { language: c.language === "other" ? heuristicLanguage(extracted.text) : c.language, sensitiveTopic: c.sensitiveTopic, categories: c.sensitiveCategories, isNewsArticle: c.isNewsArticle, reason: c.reason, model: true };
      } catch (e) {
        console.warn("[fetch-article] classification failed, using heuristic", e);
        const lang = extracted.lang === "vi" || extracted.lang === "en" ? extracted.lang : heuristicLanguage(extracted.text);
        return { language: lang, sensitiveTopic: false, categories: [] as string[], isNewsArticle: true, reason: "heuristic", model: false };
      }
    });

    await step.run("store-article", async () => {
      const { extracted } = fetched;
      let canonicalUrl = project.url;
      if (extracted.canonicalUrl) {
        try {
          const c = canonicalizeUrl(extracted.canonicalUrl);
          if (new URL(c).hostname.replace(/^www\./, "") === new URL(project.url).hostname.replace(/^www\./, "")) canonicalUrl = c;
        } catch {
          /* keep project url */
        }
      }
      await withOrgContext(ctx, async (tx) => {
        await tx.delete(schema.articles).where(eq(schema.articles.projectId, projectId));
        await tx.insert(schema.articles).values({
          organizationId,
          projectId,
          canonicalUrl,
          title: extracted.title,
          author: extracted.byline,
          siteName: extracted.siteName,
          publishedAt: extracted.publishedAt ? new Date(extracted.publishedAt) : null,
          language: classification.language,
          text: extracted.text,
          excerpt: extracted.excerpt,
          images: extracted.images,
          snapshotPath: snapshot.snapshotPath,
          screenshotPath: snapshot.screenshotPath,
          fetchMethod: fetched.method,
          flags: extracted.flags,
          wordCount: extracted.wordCount,
          // A manual paste is the user's own text: confirmed by definition.
          confirmedAt: fetched.method === "manual" ? new Date() : null,
          confirmedBy: fetched.method === "manual" ? requestedBy : null,
        });
        await tx
          .update(schema.projects)
          .set({
            title: extracted.title ?? undefined,
            canonicalUrl,
            language: classification.language,
            sensitiveTopic: classification.sensitiveTopic,
            state: "fetched",
            busyStep: null,
            lastError: null,
            inngestRunId: null,
          })
          .where(eq(schema.projects.id, projectId));
      });
      await logActivity({
        actorId: requestedBy,
        organizationId,
        projectId,
        type: "article.fetched",
        payload: {
          method: fetched.method,
          words: extracted.wordCount,
          flags: extracted.flags,
          language: classification.language,
          sensitiveTopic: classification.sensitiveTopic,
          categories: classification.categories,
          attempts: fetched.attempts,
        },
      });
    });

    return { projectId, method: fetched.method, words: fetched.extracted.wordCount, language: classification.language };
  },
);
