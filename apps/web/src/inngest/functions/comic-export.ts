import { NonRetriableError } from "inngest";
import { and, eq } from "drizzle-orm";
import type { ComicDoc } from "@ai-news/video/comic";
import { inngest } from "../client";
import { comicExportRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { presignDoc } from "@/lib/comic/flow";
import { addComicCost, clearBusy, reportComicProgress } from "@/lib/comic/service";
import { r2Key } from "@/lib/r2";
import { renderStill } from "@/lib/remotion";

/**
 * Comic studio export (docs/COMIC.md §3, M1 = PNG per page): every page of the exported version rendered by the
 * `ComicPage` composition on Remotion Lambda (`renderStillOnLambda`) straight to R2 under `renders/comics/…`. The
 * same component draws the page in the app, so the files look like the reader.
 */
export const comicExportFn = inngest.createFunction(
  {
    id: "comic-export",
    triggers: [comicExportRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.comicId" }, { limit: 5 }],
    onFailure: async ({ event }) => {
      const { comicId, organizationId, requestedBy, exportId } = event.data.event.data;
      const message = event.data.error?.message ?? "export failed";
      const ctx = { userId: requestedBy, organizationId };
      await withOrgContext(ctx, (tx) => tx.update(schema.comicExports).set({ status: "failed", error: message.slice(0, 2000) }).where(eq(schema.comicExports.id, exportId)));
      await clearBusy(ctx, comicId, message);
      await logActivity({ actorId: requestedBy, organizationId, type: "comic.export_failed", payload: { comicId, exportId, error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { comicId, organizationId, requestedBy, exportId } = event.data;
    const ctx = { userId: requestedBy, organizationId };

    const pages = await step.run("load", async () => {
      const row = await withOrgContext(ctx, async (tx) => {
        const exp = await tx.query.comicExports.findFirst({ where: and(eq(schema.comicExports.id, exportId), eq(schema.comicExports.comicId, comicId)) });
        if (!exp) return null;
        const v = await tx.query.comicVersions.findFirst({ where: eq(schema.comicVersions.id, exp.versionId) });
        return v ? { exp, doc: v.doc as unknown as ComicDoc } : null;
      });
      if (!row) throw new NonRetriableError("Export or version not found");
      if (row.exp.status === "done") return null;
      await withOrgContext(ctx, (tx) => tx.update(schema.comicExports).set({ status: "rendering" }).where(eq(schema.comicExports.id, exportId)));
      return row.doc.pages.map((p, i) => i);
    });
    if (!pages) return { skipped: "done" };

    const keys: string[] = [];
    for (const i of pages) {
      const key = await step.run(`page-${i + 1}`, async () => {
        const v = await withOrgContext(ctx, async (tx) => {
          const exp = await tx.query.comicExports.findFirst({ where: eq(schema.comicExports.id, exportId) });
          return exp ? tx.query.comicVersions.findFirst({ where: eq(schema.comicVersions.id, exp.versionId) }) : null;
        });
        const doc = v!.doc as unknown as ComicDoc;
        const page = doc.pages[i];
        const last = i === doc.pages.length - 1;
        await reportComicProgress(ctx, comicId, { label: `Xuất trang ${i + 1}/${doc.pages.length}`, pct: Math.round((i / doc.pages.length) * 95) });
        const out = await renderStill({
          composition: "ComicPage",
          inputProps: { format: doc.format, font: doc.font, page, srcs: await presignDoc({ ...doc, pages: [page] }), credit: last ? doc.credit : null },
          outKey: r2Key.comicExport(organizationId, comicId, `${exportId}/trang-${String(i + 1).padStart(2, "0")}.png`),
        });
        await recordUsageCost({ provider: "remotion_lambda", resource: "ComicPage", units: 1, unitType: "stills", costUsd: out.costUsd, userId: requestedBy, organizationId, meta: { comicId, exportId, page: i + 1 } });
        await addComicCost(ctx, comicId, out.costUsd);
        return out.key;
      });
      keys.push(key);
    }

    await step.run("done", async () => {
      await withOrgContext(ctx, async (tx) => {
        await tx.update(schema.comicExports).set({ status: "done", keys, error: null }).where(eq(schema.comicExports.id, exportId));
        await tx.update(schema.comics).set({ state: "exported" }).where(eq(schema.comics.id, comicId));
      });
      await clearBusy(ctx, comicId, null);
      await logActivity({ actorId: requestedBy, organizationId, type: "comic.exported", payload: { comicId, exportId, kind: "png", pages: keys.length } });
    });
    return { pages: keys.length };
  },
);
