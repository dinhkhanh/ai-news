import { NonRetriableError } from "inngest";
import { eq } from "drizzle-orm";
import { inngest } from "../client";
import { projectFetchRequested } from "../events";
import { autoAfterFetch } from "../auto-pipeline";
import { reportProgress } from "@/lib/progress";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { heuristicLanguage } from "@/lib/language";
import { FETCH_METHOD_LABEL as PROVIDER_LABEL, fetchArticle, fetchOrder, manualArticle, type FetchAttempt, type FetchMethod } from "@/lib/fetch";
import { classifyArticle } from "@/lib/llm/classify";
import { chooseBrandKit } from "@/lib/media/brand";
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
    /** Global cap 5 = Inngest free-tier concurrency limit; per-project lock stays at 1. */
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 5 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "fetch failed";
      await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
        tx.update(schema.projects).set({ busyStep: null, busyProgress: null, state: "failed", lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "article.fetch_failed", payload: { error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, method, manual } = event.data;
    const ctx = { userId: requestedBy, organizationId };
    const pctx = { ...ctx, projectId };

    const project = await step.run("load-project", async () => {
      await reportProgress(pctx, { label: "Mở dự án", pct: 5 });
      const row = await withOrgContext(ctx, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }));
      if (!row) throw new NonRetriableError("Project not found in this workspace");
      await withOrgContext(ctx, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", lastError: null }).where(eq(schema.projects.id, projectId)));
      return { id: row.id, url: row.url, language: row.language, brandKitId: row.brandKitId, brandKitSource: row.brandKitSource };
    });

    const fetched = await step.run("extract", async () => {
      await reportProgress(pctx, { label: manual ? "Lưu nội dung dán" : `Lấy nội dung bài (${fetchOrder(method).map((m) => PROVIDER_LABEL[m]).join(" → ")})`, pct: 10 });
      if (manual) {
        return { method: "manual" as FetchMethod, extracted: manualArticle({ ...manual, url: project.url }), rawHtml: null, screenshotB64: null, attempts: [] as FetchAttempt[] };
      }
      try {
        const out = await fetchArticle(project.url, {
          preferred: method,
          // Blocked or failed: say so and move on to the next provider, in the manual re-fetch as well.
          onAttempt: (next, previous) =>
            previous
              ? reportProgress(pctx, { label: `${PROVIDER_LABEL[previous.method]} ${previous.blocked ? "bị chặn" : "không lấy được bài"}, chuyển sang ${PROVIDER_LABEL[next]}`, pct: 10 + 15 * fetchOrder(method).indexOf(next) })
              : undefined,
        });
        return { method: out.method, extracted: out.extracted, rawHtml: out.rawHtml, screenshotB64: out.screenshot?.toString("base64") ?? null, attempts: out.attempts };
      } catch (e) {
        // Every provider failed: not worth retrying automatically; the user picks a fallback.
        throw new NonRetriableError(e instanceof Error ? e.message : String(e));
      }
    });

    const snapshot = await step.run("snapshot-to-r2", async () => {
      await reportProgress(pctx, { label: "Lưu bản chụp trang", pct: 60 });
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
      await reportProgress(pctx, { label: "Nhận diện ngôn ngữ và chủ đề nhạy cảm (Haiku)", pct: 70 });
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

    // A kit picked by hand when the project was created is never overwritten.
    const kit = await step.run("brand-kit", async () => {
      if (project.brandKitSource === "manual" && project.brandKitId) return null;
      await reportProgress(pctx, { label: "Chọn bộ nhận diện theo nội dung", pct: 85 });
      try {
        return await chooseBrandKit({ ...ctx, projectId }, { title: fetched.extracted.title, text: fetched.extracted.text });
      } catch (e) {
        console.warn("[fetch-article] brand kit choice failed, the default kit is used", e);
        return null;
      }
    });

    await step.run("store-article", async () => {
      await reportProgress(pctx, { label: "Lưu bài báo", pct: 92 });
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
            ...(kit ? { brandKitId: kit.id, brandKitSource: kit.id ? ("auto" as const) : null, brandKitReason: kit.reason } : {}),
            state: "fetched",
            busyStep: null, busyProgress: null,
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
          brandKit: kit ? { id: kit.id, name: kit.name, method: kit.method, reason: kit.reason } : null,
          attempts: fetched.attempts,
        },
      });
    });

    const next = await step.run("auto-continue", () => autoAfterFetch(ctx, projectId));
    if (next) await step.sendEvent("auto-script", next);

    return { projectId, method: fetched.method, words: fetched.extracted.wordCount, language: classification.language, auto: Boolean(next) };
  },
);
