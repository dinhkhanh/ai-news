import { NonRetriableError } from "inngest";
import { and, eq, inArray, ne } from "drizzle-orm";
import { planStrip, STRIP_WIDTH, type ComicDoc } from "@ai-news/video/comic";
import { inngest } from "../client";
import { comicExportRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { jpegPdf, pdfPageSize, zipStore } from "@/lib/comic/files";
import { presignDoc } from "@/lib/comic/flow";
import { slug } from "@/lib/comic/script";
import { addComicCost, clearBusy, reportComicProgress, type Ctx } from "@/lib/comic/service";
import { getObjectBuffer, putObject, r2Key } from "@/lib/r2";
import { renderStill } from "@/lib/remotion";

/**
 * Comic studio export (docs/COMIC.md §2.7, §3). One request = one `comic_exports` row per kind, all of the same
 * version: `png` (every page rendered by the `ComicPage` composition on Remotion Lambda, the component the reader
 * uses), `pdf` (the pages again as JPEG, one per PDF page), `webtoon` (`planStrip` slices rendered by `ComicStrip`,
 * 800 px wide files of at most 8 000 px, cut between panels) and `zip` (all of them in one archive). PNG pages of a
 * finished export of the same version are reused instead of rendered again.
 */
export const comicExportFn = inngest.createFunction(
  {
    id: "comic-export",
    triggers: [comicExportRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.comicId" }, { limit: 5 }],
    onFailure: async ({ event }) => {
      const { comicId, organizationId, requestedBy, exportId, exportIds } = event.data.event.data;
      const message = event.data.error?.message ?? "export failed";
      const ctx = { userId: requestedBy, organizationId };
      await withOrgContext(ctx, (tx) =>
        tx
          .update(schema.comicExports)
          .set({ status: "failed", error: message.slice(0, 2000) })
          .where(and(inArray(schema.comicExports.id, exportIds ?? [exportId]), ne(schema.comicExports.status, "done"))),
      );
      await clearBusy(ctx, comicId, message);
      await logActivity({ actorId: requestedBy, organizationId, type: "comic.export_failed", payload: { comicId, exportId, error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { comicId, organizationId, requestedBy, exportId } = event.data;
    const exportIds = event.data.exportIds ?? [exportId];
    const ctx: Ctx = { userId: requestedBy, organizationId };
    const folder = (name: string) => r2Key.comicExport(organizationId, comicId, `${exportId}/${name}`);

    const job = await step.run("load", async () => {
      const found = await withOrgContext(ctx, async (tx) => {
        const rows = await tx.query.comicExports.findMany({ where: and(inArray(schema.comicExports.id, exportIds), eq(schema.comicExports.comicId, comicId)) });
        const comic = await tx.query.comics.findFirst({ where: eq(schema.comics.id, comicId), columns: { title: true } });
        return { rows, comic };
      });
      const todo = found.rows.filter((r) => r.status !== "done");
      if (!todo.length) return null;
      const versionId = found.rows[0].versionId;
      if (found.rows.some((r) => r.versionId !== versionId)) throw new NonRetriableError("Exports of one request must share a version");
      const doc = await loadDoc(ctx, versionId);
      await withOrgContext(ctx, (tx) => tx.update(schema.comicExports).set({ status: "rendering" }).where(inArray(schema.comicExports.id, todo.map((r) => r.id))));
      const kinds = new Set(todo.map((r) => r.kind));
      // Pages of an earlier PNG export of the same version: same document, same files.
      const earlier = kinds.has("png") || kinds.has("zip") ? await withOrgContext(ctx, (tx) =>
        tx.query.comicExports.findFirst({
          where: and(eq(schema.comicExports.versionId, versionId), eq(schema.comicExports.kind, "png"), eq(schema.comicExports.status, "done"), ne(schema.comicExports.id, exportId)),
          columns: { keys: true },
        }),
      ) : undefined;
      return {
        versionId,
        rows: todo.map((r) => ({ id: r.id, kind: r.kind })),
        pages: doc.pages.length,
        name: slug(found.comic?.title ?? "") || "truyen-tranh",
        title: found.comic?.title ?? "Truyện tranh",
        png: kinds.has("png") || kinds.has("zip"),
        pdf: kinds.has("pdf") || kinds.has("zip"),
        strip: kinds.has("webtoon") || kinds.has("zip"),
        zip: kinds.has("zip"),
        reuse: earlier && earlier.keys.length === doc.pages.length ? earlier.keys : null,
      };
    });
    if (!job) return { skipped: "done" };

    // Every rendered still is a step of its own (Lambda cost recorded per still).
    const still = (id: string, label: string, pct: number, render: (doc: ComicDoc) => Promise<{ key: string; costUsd: number; meta: Record<string, unknown>; composition: string }>) =>
      step.run(id, async () => {
        const doc = await loadDoc(ctx, job.versionId);
        await reportComicProgress(ctx, comicId, { label, pct });
        const out = await render(doc);
        await recordUsageCost({ provider: "remotion_lambda", resource: out.composition, units: 1, unitType: "stills", costUsd: out.costUsd, userId: requestedBy, organizationId, meta: { comicId, exportId, ...out.meta } });
        await addComicCost(ctx, comicId, out.costUsd);
        return out.key;
      });
    const pageNo = (i: number) => String(i + 1).padStart(2, "0");
    const renderPage = async (doc: ComicDoc, i: number, imageFormat: "png" | "jpeg", outKey: string) => {
      const o = await renderStill({
        composition: "ComicPage",
        inputProps: { format: doc.format, font: doc.font, page: doc.pages[i], srcs: await presignDoc({ ...doc, pages: [doc.pages[i]] }), credit: i === doc.pages.length - 1 ? doc.credit : null },
        outKey,
        imageFormat,
      });
      return { key: o.key, costUsd: o.costUsd, composition: "ComicPage", meta: { page: i + 1, format: imageFormat } };
    };

    let pngKeys: string[] = [];
    if (job.png) {
      if (job.reuse) pngKeys = job.reuse;
      else
        for (let i = 0; i < job.pages; i++)
          pngKeys.push(await still(`page-${i + 1}`, `Xuất trang ${i + 1}/${job.pages}`, Math.round((i / job.pages) * 40), (doc) => renderPage(doc, i, "png", folder(`trang-${pageNo(i)}.png`))));
    }

    let pdfKey: string | null = null;
    if (job.pdf) {
      const jpgs: string[] = [];
      for (let i = 0; i < job.pages; i++)
        jpgs.push(await still(`pdf-page-${i + 1}`, `Dựng PDF: trang ${i + 1}/${job.pages}`, 40 + Math.round((i / job.pages) * 25), (doc) => renderPage(doc, i, "jpeg", r2Key.tmp(organizationId, `comic-${comicId}`, `${exportId}/trang-${pageNo(i)}.jpg`))));
      pdfKey = await step.run("pdf", async () => {
        const doc = await loadDoc(ctx, job.versionId);
        await reportComicProgress(ctx, comicId, { label: "Ghép PDF…", pct: 66 });
        const pages = await Promise.all(
          jpgs.map(async (key, i) => {
            const width = Math.round(doc.format.width);
            const height = Math.round(doc.pages[i].height);
            return { jpeg: new Uint8Array(await getObjectBuffer(key)), width, height, ...pdfPageSize(doc.format.id, width, height) };
          }),
        );
        const key = folder(`${job.name}.pdf`);
        await putObject(key, jpegPdf(pages, { title: job.title }), "application/pdf");
        return key;
      });
    }

    const stripKeys: string[] = [];
    if (job.strip) {
      const parts = await step.run("strip-plan", async () => planStrip(await loadDoc(ctx, job.versionId)).map((p) => p.height));
      for (let n = 0; n < parts.length; n++)
        stripKeys.push(
          await still(`strip-${n + 1}`, `Dựng webtoon: phần ${n + 1}/${parts.length}`, 66 + Math.round((n / parts.length) * 20), async (doc) => {
            const part = planStrip(doc)[n];
            const pages = [...new Set(part.pieces.map((p) => p.page))].map((i) => doc.pages[i]);
            const o = await renderStill({
              composition: "ComicStrip",
              inputProps: {
                format: doc.format,
                font: doc.font,
                width: STRIP_WIDTH,
                height: part.height,
                pieces: part.pieces.map((p) => ({ page: doc.pages[p.page], srcTop: p.srcTop, dstTop: p.dstTop, dstHeight: p.dstHeight, credit: p.page === doc.pages.length - 1 ? doc.credit : null })),
                srcs: await presignDoc({ ...doc, pages }),
              },
              outKey: folder(`webtoon/${job.name}-${pageNo(n)}.jpg`),
              imageFormat: "jpeg",
            });
            return { key: o.key, costUsd: o.costUsd, composition: "ComicStrip", meta: { part: n + 1 } };
          }),
        );
    }

    let zipKey: string | null = null;
    if (job.zip) {
      zipKey = await step.run("zip", async () => {
        await reportComicProgress(ctx, comicId, { label: "Nén tệp zip…", pct: 90 });
        const files = [
          ...pngKeys.map((key, i) => ({ key, name: `trang-${pageNo(i)}.png` })),
          ...(pdfKey ? [{ key: pdfKey, name: `${job.name}.pdf` }] : []),
          ...stripKeys.map((key, n) => ({ key, name: `webtoon/${job.name}-${pageNo(n)}.jpg` })),
        ];
        const entries = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await getObjectBuffer(f.key)) })));
        const key = folder(`${job.name}.zip`);
        await putObject(key, zipStore(entries), "application/zip");
        return key;
      });
    }

    await step.run("done", async () => {
      const keysOf: Record<string, string[]> = { png: pngKeys, pdf: pdfKey ? [pdfKey] : [], webtoon: stripKeys, zip: zipKey ? [zipKey] : [] };
      await withOrgContext(ctx, async (tx) => {
        for (const r of job.rows) await tx.update(schema.comicExports).set({ status: "done", keys: keysOf[r.kind] ?? [], error: null }).where(eq(schema.comicExports.id, r.id));
        await tx.update(schema.comics).set({ state: "exported" }).where(eq(schema.comics.id, comicId));
      });
      await clearBusy(ctx, comicId, null);
      await logActivity({ actorId: requestedBy, organizationId, type: "comic.exported", payload: { comicId, exportId, kinds: job.rows.map((r) => r.kind), pages: job.pages, reusedPages: Boolean(job.reuse), webtoonParts: stripKeys.length } });
    });
    return { kinds: job.rows.map((r) => r.kind), pages: job.pages, webtoonParts: stripKeys.length };
  },
);

async function loadDoc(ctx: Ctx, versionId: string) {
  const v = await withOrgContext(ctx, (tx) => tx.query.comicVersions.findFirst({ where: eq(schema.comicVersions.id, versionId) }));
  if (!v) throw new NonRetriableError("Version not found");
  return v.doc as unknown as ComicDoc;
}
