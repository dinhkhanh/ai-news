import { NonRetriableError } from "inngest";
import { and, eq, inArray } from "drizzle-orm";
import type { CastMember } from "@ai-news/video/comic";
import { inngest } from "../client";
import { comicCastRequested, comicDrawRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { applyPanelImage, docStats, findPanel, panelsToDraw, setPanelError } from "@/lib/comic/doc";
import { panelRequest, sheetRequest } from "@/lib/comic/drawing";
import { drawComicImage } from "@/lib/comic/images";
import { addComicCost, clearBusy, comicDrawAccess, loadComic, reportComicProgress, sheetsFor, styleOf, updateDoc, type Ctx } from "@/lib/comic/service";

/** Parallel image requests per comic (Vertex rate limits, docs/COMIC.md §8). */
const BATCH = 4;

type SheetTarget = { ref: string; characterId: string; name: string; visual: string; referenceKeys: string[] };
type SheetResult = { ref: string; key: string | null; error: string | null };

async function sheetTargets(ctx: Ctx, members: CastMember[]): Promise<SheetTarget[]> {
  const ids = members.flatMap((m) => (m.characterId ? [m.characterId] : []));
  if (!ids.length) return [];
  const rows = await withOrgContext(ctx, (tx) =>
    tx
      .select({ id: schema.comicCharacters.id, referenceKeys: schema.comicCharacters.referenceKeys })
      .from(schema.comicCharacters)
      .where(and(inArray(schema.comicCharacters.id, ids), eq(schema.comicCharacters.organizationId, ctx.organizationId))),
  );
  return members.flatMap((m) => {
    const row = rows.find((r) => r.id === m.characterId);
    return row ? [{ ref: m.ref, characterId: row.id, name: m.name, visual: m.visual, referenceKeys: row.referenceKeys }] : [];
  });
}

async function drawSheet(ctx: Ctx, comicId: string, t: SheetTarget, projectId: string, instruction?: string | null): Promise<SheetResult> {
  const loaded = await loadComic(ctx, comicId);
  if (!loaded) return { ref: t.ref, key: null, error: "comic gone" };
  const style = styleOf(loaded.comic);
  const req = sheetRequest(t, style, t.referenceKeys, loaded.comic.imageModel, instruction);
  try {
    const img = await drawComicImage(ctx, { kind: "sheet", modelId: loaded.comic.imageModel, prompt: req.prompt, refKeys: req.refKeys, aspect: req.aspect, projectId, comicId, characterId: t.characterId, styleId: loaded.comic.styleId, instruction });
    await addComicCost(ctx, comicId, img.costUsd);
    return { ref: t.ref, key: img.key, error: null };
  } catch (e) {
    return { ref: t.ref, key: null, error: (e as Error).message.slice(0, 300) };
  }
}

const failComic = async (data: { comicId: string; organizationId: string; requestedBy: string }, message: string, type: string) => {
  await clearBusy({ userId: data.requestedBy, organizationId: data.organizationId }, data.comicId, message);
  await logActivity({ actorId: data.requestedBy, organizationId: data.organizationId, type, payload: { comicId: data.comicId, error: message.slice(0, 500) } });
};

/** Comic studio step 4 (docs/COMIC.md §6): one reference sheet per cast member in the comic's style. */
export const comicCastFn = inngest.createFunction(
  {
    id: "comic-cast",
    triggers: [comicCastRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.comicId" }, { limit: 5 }],
    onFailure: ({ event }) => failComic(event.data.event.data, event.data.error?.message ?? "sheets failed", "comic.cast_failed"),
  },
  async ({ event, step }) => {
    const { comicId, organizationId, requestedBy, refs, instruction } = event.data;
    const ctx = { userId: requestedBy, organizationId };
    const plan = await step.run("plan", async () => {
      const loaded = await loadComic(ctx, comicId);
      if (!loaded?.version) throw new NonRetriableError("Comic or script not found");
      if (loaded.comic.busyStep !== "cast") return { skipped: true as const };
      const access = await comicDrawAccess(requestedBy);
      if (!access.ok) throw new NonRetriableError(access.reason);
      const members = await sheetTargets(ctx, loaded.version.doc.cast);
      const have = await sheetsFor(ctx, members.map((m) => m.characterId), loaded.comic.styleId);
      const targets = (refs?.length ? members.filter((m) => refs.includes(m.ref)) : members.filter((m) => !have.has(m.characterId))).slice(0, Number.isFinite(access.remaining) ? access.remaining : undefined);
      await reportComicProgress(ctx, comicId, { label: `Vẽ bản mẫu nhân vật 0/${targets.length}`, pct: 5 });
      return { skipped: false as const, projectId: access.projectId, targets };
    });
    if (plan.skipped) return plan;
    const results: SheetResult[] = [];
    for (let i = 0; i < plan.targets.length; i += BATCH) {
      const batch = plan.targets.slice(i, i + BATCH);
      results.push(
        ...(await Promise.all(
          batch.map((t) =>
            step.run(`sheet-${t.ref}`, async () => {
              const r = await drawSheet(ctx, comicId, t, plan.projectId, instruction);
              await reportComicProgress(ctx, comicId, { label: `Vẽ bản mẫu nhân vật ${Math.min(i + BATCH, plan.targets.length)}/${plan.targets.length}`, pct: Math.round(((i + batch.length) / plan.targets.length) * 95) });
              return r;
            }),
          ),
        )),
      );
    }
    await step.run("done", async () => {
      const failed = results.filter((r) => r.error);
      await clearBusy(ctx, comicId, failed.length ? `Không vẽ được bản mẫu: ${failed.map((f) => `${f.ref}: ${f.error}`).join("; ")}`.slice(0, 1000) : null);
      await logActivity({ actorId: requestedBy, organizationId, type: "comic.sheets_drawn", payload: { comicId, drawn: results.length - failed.length, failed: failed.length, instruction: instruction ?? null } });
    });
    return { drawn: results.filter((r) => r.key).length, failed: results.filter((r) => r.error).length };
  },
);

/**
 * Comic studio step 5 (docs/COMIC.md §6, §8): the panels without a picture (or the ones asked for again), four at
 * a time. Characters without a sheet in the comic's style get one first. Each picture lands in the document as soon
 * as it is drawn (re-lettered around the faces found), so the page fills in while the run goes on; a panel that
 * fails keeps its error and never fails the comic.
 */
export const comicDrawFn = inngest.createFunction(
  {
    id: "comic-draw",
    triggers: [comicDrawRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.comicId" }, { limit: 5 }],
    onFailure: ({ event }) => failComic(event.data.event.data, event.data.error?.message ?? "drawing failed", "comic.draw_failed"),
  },
  async ({ event, step }) => {
    const { comicId, organizationId, requestedBy, panelIds, instruction } = event.data;
    const ctx = { userId: requestedBy, organizationId };

    const plan = await step.run("plan", async () => {
      const loaded = await loadComic(ctx, comicId);
      if (!loaded?.version) throw new NonRetriableError("Comic or script not found");
      if (loaded.comic.busyStep !== "draw") return { skipped: true as const };
      const access = await comicDrawAccess(requestedBy);
      if (!access.ok) throw new NonRetriableError(access.reason);
      const doc = loaded.version.doc;
      const wanted = panelIds?.length ? panelIds.filter((id) => findPanel(doc, id)) : panelsToDraw(doc).map((k) => k.id);
      const inPanels = new Set(wanted.flatMap((id) => findPanel(doc, id)!.panel.script.characters.map((c) => c.ref)));
      const members = await sheetTargets(ctx, doc.cast.filter((c) => inPanels.has(c.ref)));
      const have = await sheetsFor(ctx, members.map((m) => m.characterId), loaded.comic.styleId);
      const budget = Number.isFinite(access.remaining) ? access.remaining : Infinity;
      const sheets = members.filter((m) => !have.has(m.characterId)).slice(0, Math.max(0, budget));
      const panels = wanted.slice(0, Math.max(0, budget - sheets.length));
      const known = members.flatMap((m) => (have.has(m.characterId) ? [{ ref: m.ref, key: have.get(m.characterId)!.key }] : []));
      await withOrgContext(ctx, (tx) => tx.update(schema.comics).set({ state: "drawing" }).where(eq(schema.comics.id, comicId)));
      await reportComicProgress(ctx, comicId, { label: sheets.length ? `Vẽ bản mẫu nhân vật (${sheets.length})…` : `Vẽ khung 0/${panels.length}`, pct: 2 });
      return { skipped: false as const, projectId: access.projectId, sheets, known, panels, cut: wanted.length - panels.length };
    });
    if (plan.skipped) return plan;

    const sheetKeys = new Map(plan.known.map((k) => [k.ref, k.key]));
    for (let i = 0; i < plan.sheets.length; i += BATCH) {
      const done = await Promise.all(plan.sheets.slice(i, i + BATCH).map((t) => step.run(`sheet-${t.ref}`, () => drawSheet(ctx, comicId, t, plan.projectId))));
      for (const r of done) if (r.key) sheetKeys.set(r.ref, r.key);
    }

    let finished = 0;
    const outcomes: { panelId: string; ok: boolean; error: string | null }[] = [];
    for (let i = 0; i < plan.panels.length; i += BATCH) {
      const batch = plan.panels.slice(i, i + BATCH);
      const done = await Promise.all(
        batch.map((panelId) =>
          step.run(`panel-${panelId}`, async () => {
            const loaded = await loadComic(ctx, comicId);
            const hit = loaded?.version ? findPanel(loaded.version.doc, panelId) : null;
            if (!loaded?.version || !hit) return { panelId, ok: false, error: "panel removed" };
            const req = panelRequest(loaded.version.doc, hit.panel, styleOf(loaded.comic), sheetKeys, loaded.comic.imageModel, instruction);
            try {
              const img = await drawComicImage(ctx, { kind: "panel", modelId: loaded.comic.imageModel, prompt: req.prompt, refKeys: req.refKeys, aspect: req.aspect, projectId: plan.projectId, comicId, panelId, styleId: loaded.comic.styleId, instruction });
              await updateDoc(ctx, comicId, "draw", (doc) => (findPanel(doc, panelId) ? { doc: applyPanelImage(doc, panelId, { id: img.id, key: img.key, width: img.width, height: img.height, faces: img.faces }), changes: { drewPanel: panelId } } : null));
              await addComicCost(ctx, comicId, img.costUsd);
              return { panelId, ok: true, error: null };
            } catch (e) {
              const message = (e as Error).message.slice(0, 300);
              await updateDoc(ctx, comicId, "draw", (doc) => (findPanel(doc, panelId) ? { doc: setPanelError(doc, panelId, message), changes: { panelError: panelId } } : null)).catch(() => undefined);
              return { panelId, ok: false, error: message };
            }
          }),
        ),
      );
      outcomes.push(...done);
      finished += batch.length;
      await step.run(`progress-${i}`, () => reportComicProgress(ctx, comicId, { label: `Vẽ khung ${finished}/${plan.panels.length}`, pct: Math.round(5 + (finished / Math.max(1, plan.panels.length)) * 93) }));
    }

    return step.run("done", async () => {
      const loaded = await loadComic(ctx, comicId);
      const stats = loaded?.version ? docStats(loaded.version.doc) : null;
      const failed = outcomes.filter((o) => !o.ok && o.error !== "panel removed");
      const notes = [failed.length ? `${failed.length} khung vẽ lỗi (bấm “Vẽ lại” ở khung đó)` : "", plan.cut ? `${plan.cut} khung chưa vẽ vì hết hạn mức hôm nay` : ""].filter(Boolean).join(" · ");
      await clearBusy(ctx, comicId, notes || null, stats && stats.drawn === stats.panels ? "drawn" : undefined);
      await logActivity({ actorId: requestedBy, organizationId, type: panelIds?.length ? "comic.panel_redrawn" : "comic.panels_drawn", payload: { comicId, drawn: outcomes.length - failed.length, failed: failed.length, cut: plan.cut, sheets: plan.sheets.length, instruction: instruction ?? null } });
      return { drawn: outcomes.length - failed.length, failed: failed.length, cut: plan.cut };
    });
  },
);
