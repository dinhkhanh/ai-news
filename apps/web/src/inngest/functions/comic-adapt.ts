import { NonRetriableError } from "inngest";
import { COMIC_FONTS, type ComicFont } from "@ai-news/video/comic";
import { inngest } from "../client";
import { comicAdaptRequested, comicDrawRequested } from "../events";
import { logActivity } from "@/lib/activity";
import { adaptComic, rewriteComicPage } from "@/lib/comic/adapt";
import { AI_CREDIT_COMIC, buildDoc, replacePage } from "@/lib/comic/doc";
import { adaptInputFor, approveScript } from "@/lib/comic/flow";
import { formatOf } from "@/lib/comic/layout";
import { addComicCost, claimBusy, clearBusy, loadComic, optionsOf, reportComicProgress, updateDoc, writeDoc } from "@/lib/comic/service";
import { isPermanentLlmError } from "@/lib/llm/client";

/**
 * Comic studio step 2 (docs/COMIC.md §4): the story becomes a script, or one page is written again. Without script
 * review ("Vẽ luôn") the script is approved here and the drawing is queued right away.
 */
export const comicAdaptFn = inngest.createFunction(
  {
    id: "comic-adapt",
    triggers: [comicAdaptRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.comicId" }, { limit: 5 }],
    onFailure: async ({ event }) => {
      const { comicId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "adaptation failed";
      await clearBusy({ userId: requestedBy, organizationId }, comicId, message);
      await logActivity({ actorId: requestedBy, organizationId, type: "comic.adapt_failed", payload: { comicId, error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { comicId, organizationId, requestedBy, pageId, instruction } = event.data;
    const ctx = { userId: requestedBy, organizationId };

    const result = await step.run("adapt", async () => {
      const loaded = await loadComic(ctx, comicId);
      if (!loaded) throw new NonRetriableError("Comic not found in this workspace");
      // Queued twice, or the member started something else meanwhile: this event is obsolete.
      if (loaded.comic.busyStep !== "adapt") return { skipped: true as const };
      const input = await adaptInputFor(ctx, loaded.comic);
      try {
        if (pageId) {
          if (!loaded.version) throw new NonRetriableError("Nothing to rewrite yet");
          const doc = loaded.version.doc;
          const index = doc.pages.findIndex((p) => p.id === pageId);
          if (index < 0) throw new NonRetriableError("That page no longer exists");
          await reportComicProgress(ctx, comicId, { label: `Đang viết lại trang ${index + 1}…`, pct: 20 });
          const { page, costUsd } = await rewriteComicPage(input, doc, index, instruction ?? "", loaded.comic.textModel, { ...ctx, comicId });
          await updateDoc(ctx, comicId, "adapt", (d) => ({ doc: replacePage(d, pageId, page), changes: { rewrotePage: index + 1, instruction: instruction ?? null } }));
          await addComicCost(ctx, comicId, costUsd);
          return { skipped: false as const, pages: doc.pages.length, rewrote: index + 1, costUsd };
        }
        await reportComicProgress(ctx, comicId, { label: "Claude đang chuyển thể truyện…", pct: 10 });
        const { script, costUsd, model } = await adaptComic(input, loaded.comic.textModel, { ...ctx, comicId });
        const opts = optionsOf(loaded.comic);
        const font = (opts.font && opts.font in COMIC_FONTS ? opts.font : "itim") as ComicFont;
        const doc = buildDoc(script, {
          format: formatOf(loaded.comic.format),
          readingDirection: loaded.comic.readingDirection === "rtl" ? "rtl" : "ltr",
          language: loaded.comic.language,
          font,
          credit: opts.credit === false ? null : AI_CREDIT_COMIC[loaded.comic.language],
        });
        await writeDoc(ctx, comicId, doc, "adapt", "adapted", { model, pages: doc.pages.length });
        await addComicCost(ctx, comicId, costUsd);
        return { skipped: false as const, pages: doc.pages.length, panels: doc.pages.reduce((s, p) => s + p.panels.length, 0), newCast: doc.cast.filter((c) => !c.characterId).length, costUsd, review: opts.review !== false };
      } catch (e) {
        if (isPermanentLlmError(e)) throw new NonRetriableError((e as Error).message);
        throw e;
      }
    });
    if (result.skipped) return result;

    const auto = "review" in result && result.review === false;
    await step.run("done", async () => {
      if (auto) await approveScript(ctx, comicId);
      await clearBusy(ctx, comicId, null);
      await logActivity({ actorId: requestedBy, organizationId, type: "rewrote" in result ? "comic.page_rewritten" : "comic.adapted", payload: { comicId, ...result } });
    });
    if (auto) {
      await step.run("queue-draw", () => claimBusy(ctx, comicId, "draw"));
      await step.sendEvent("auto-draw", comicDrawRequested.create({ comicId, organizationId, requestedBy }));
    }
    return result;
  },
);
