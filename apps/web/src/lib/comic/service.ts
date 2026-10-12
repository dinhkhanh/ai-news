import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { comicDocSchema, type ComicDoc } from "@ai-news/video/comic";
import { schema } from "@/db";
import { withOrgContext, type Tx } from "@/db/context";
import { flagEnabled } from "@/lib/flags";
import { vertexImageAccess } from "@/lib/media/generate";
import { startProgress } from "@/lib/project-state";
import { dailyLimit, usedToday } from "@/lib/quota";
import { openaiImageAccess } from "./images";
import { imageModel } from "./models";
import type { ComicStyle } from "./prompts";

/**
 * Comic studio data access (docs/COMIC.md §7, §8): the current document, immutable versions, the busy flag the page
 * polls, the running cost, and whether pictures can be drawn now. Every document change goes through `updateDoc`,
 * which locks the comic row, so a drawing job and a person editing the script never overwrite each other.
 */

export type Ctx = { userId: string; organizationId: string };
export type ComicRow = typeof schema.comics.$inferSelect;
export type ComicState = "created" | "adapted" | "script_approved" | "drawing" | "drawn" | "exported";
export type VersionKind = "adapt" | "edit" | "draw" | "letter";

export async function loadComic(ctx: Ctx, comicId: string) {
  return withOrgContext(ctx, async (tx) => {
    const comic = await tx.query.comics.findFirst({ where: and(eq(schema.comics.id, comicId), eq(schema.comics.organizationId, ctx.organizationId)) });
    if (!comic) return null;
    const version = comic.currentVersionId ? await tx.query.comicVersions.findFirst({ where: eq(schema.comicVersions.id, comic.currentVersionId) }) : null;
    return { comic, version: version ? { id: version.id, createdAt: version.createdAt, doc: version.doc as unknown as ComicDoc } : null };
  });
}

export const styleOf = (comic: Pick<ComicRow, "styleSnapshot">) => comic.styleSnapshot as unknown as ComicStyle;
export const optionsOf = (comic: Pick<ComicRow, "options">) =>
  comic.options as { dialogue?: "low" | "medium" | "high"; free?: boolean; review?: boolean; castIds?: string[]; font?: string; credit?: boolean; qualityGate?: boolean };

async function lockedComic(tx: Tx, ctx: Ctx, comicId: string) {
  const [comic] = await tx
    .select()
    .from(schema.comics)
    .where(and(eq(schema.comics.id, comicId), eq(schema.comics.organizationId, ctx.organizationId)))
    .for("update");
  if (!comic) throw new Error("Truyện không còn tồn tại");
  return comic;
}

/**
 * Applies `fn` to the current document and stores the result as a new version (parent = the current one). `fn`
 * runs inside the transaction holding the comic's row lock; returning null leaves everything as it is.
 */
export async function updateDoc(
  ctx: Ctx,
  comicId: string,
  kind: VersionKind,
  fn: (doc: ComicDoc, comic: ComicRow) => { doc: ComicDoc; changes?: Record<string, unknown> } | null,
  opts: { state?: ComicState; expectVersionId?: string } = {},
) {
  return withOrgContext(ctx, async (tx) => {
    const comic = await lockedComic(tx, ctx, comicId);
    if (opts.expectVersionId && comic.currentVersionId !== opts.expectVersionId) throw new Error("Truyện vừa được sửa ở nơi khác: tải lại trang rồi làm lại");
    const current = comic.currentVersionId ? await tx.query.comicVersions.findFirst({ where: eq(schema.comicVersions.id, comic.currentVersionId) }) : null;
    if (!current) throw new Error("Truyện chưa có kịch bản");
    const out = fn(current.doc as unknown as ComicDoc, comic);
    if (!out) return { versionId: current.id, doc: current.doc as unknown as ComicDoc, changed: false };
    const doc = comicDocSchema.parse(out.doc);
    const [v] = await tx
      .insert(schema.comicVersions)
      .values({ organizationId: ctx.organizationId, comicId, parentId: current.id, kind, doc: doc as unknown as Record<string, unknown>, changes: out.changes ?? {}, createdBy: ctx.userId || null })
      .returning({ id: schema.comicVersions.id });
    await tx
      .update(schema.comics)
      .set({ currentVersionId: v.id, title: doc.title || comic.title, lockVersion: sql`${schema.comics.lockVersion} + 1`, ...(opts.state ? { state: opts.state } : {}) })
      .where(eq(schema.comics.id, comicId));
    return { versionId: v.id, doc, changed: true };
  });
}

/** The first version of a comic (the adaptation), or a whole new document (re-adaptation). */
export async function writeDoc(ctx: Ctx, comicId: string, doc: ComicDoc, kind: VersionKind, state: ComicState, changes: Record<string, unknown> = {}) {
  const parsed = comicDocSchema.parse(doc);
  return withOrgContext(ctx, async (tx) => {
    const comic = await lockedComic(tx, ctx, comicId);
    const [v] = await tx
      .insert(schema.comicVersions)
      .values({ organizationId: ctx.organizationId, comicId, parentId: comic.currentVersionId, kind, doc: parsed as unknown as Record<string, unknown>, changes, createdBy: ctx.userId || null })
      .returning({ id: schema.comicVersions.id });
    await tx
      .update(schema.comics)
      .set({ currentVersionId: v.id, title: parsed.title || comic.title, state, lockVersion: sql`${schema.comics.lockVersion} + 1` })
      .where(eq(schema.comics.id, comicId));
    return v.id;
  });
}

/** Marks a step as queued; fails when another step still runs (and is not stale). */
export async function claimBusy(ctx: Ctx, comicId: string, step: string, label = "Đang xếp hàng…") {
  return withOrgContext(ctx, async (tx) => {
    const comic = await lockedComic(tx, ctx, comicId);
    if (comic.busyStep && Date.now() - comic.updatedAt.getTime() < 15 * 60 * 1000) throw new Error("Truyện đang chạy một bước khác, đợi xong đã");
    await tx.update(schema.comics).set({ busyStep: step, busyProgress: startProgress(label), lastError: null }).where(eq(schema.comics.id, comicId));
  });
}

export async function reportComicProgress(ctx: Ctx, comicId: string, p: { label: string; pct?: number | null }) {
  const now = new Date().toISOString();
  const patch = JSON.stringify({ label: p.label, pct: p.pct ?? null, at: now });
  await withOrgContext(ctx, (tx) =>
    tx
      .update(schema.comics)
      .set({ busyProgress: sql`jsonb_build_object('startedAt', coalesce(${schema.comics.busyProgress}->>'startedAt', ${now}::text)) || coalesce(${schema.comics.busyProgress}, '{}'::jsonb) || ${patch}::jsonb` })
      .where(eq(schema.comics.id, comicId)),
  ).catch((e) => console.warn("[comic] progress failed", e));
}

export async function clearBusy(ctx: Ctx, comicId: string, error?: string | null, state?: ComicState) {
  await withOrgContext(ctx, (tx) =>
    tx
      .update(schema.comics)
      .set({ busyStep: null, busyProgress: null, ...(error !== undefined ? { lastError: error ? error.slice(0, 1000) : null } : {}), ...(state ? { state } : {}) })
      .where(eq(schema.comics.id, comicId)),
  );
}

export async function addComicCost(ctx: Ctx, comicId: string, usd: number) {
  if (!(usd > 0)) return;
  await withOrgContext(ctx, (tx) =>
    tx
      .update(schema.comics)
      .set({ costUsd: sql`${schema.comics.costUsd} + ${usd.toFixed(6)}::numeric` })
      .where(eq(schema.comics.id, comicId)),
  );
}

export type DrawAccess = { ok: true; projectId: string | null; remaining: number } | { ok: false; reason: string };

/**
 * Whether this member may draw pictures with `modelId` now: flag `comics`, the model's integration and its cap
 * (`google_veo` for Gemini, `openai` for GPT Image), the daily quota. `projectId` is the Vertex project (null for OpenAI).
 */
export async function comicDrawAccess(userId: string, modelId: string | null | undefined): Promise<DrawAccess> {
  if (!(await flagEnabled("comics"))) return { ok: false, reason: "Truyện tranh đang tắt (cờ comics)" };
  const model = imageModel(modelId);
  const access = model.provider === "openai" ? await openaiImageAccess() : await vertexImageAccess();
  if (!access.ok) return { ok: false, reason: `${model.label}: ${access.reason}` };
  const [limit, used] = await Promise.all([dailyLimit(userId, "comic_images"), usedToday(userId, "comic_images")]);
  const remaining = limit > 0 ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY;
  if (remaining === 0) return { ok: false, reason: `Hết hạn mức ảnh truyện tranh hôm nay (${used}/${limit})` };
  return { ok: true, projectId: "projectId" in access ? access.projectId : null, remaining };
}

/** Latest sheet per character for a style: an accepted one wins over drafts. */
export async function sheetsFor(ctx: Ctx, characterIds: string[], styleId: string | null) {
  if (!characterIds.length || !styleId) return new Map<string, { id: string; key: string; status: string }>();
  const rows = await withOrgContext(ctx, (tx) =>
    tx
      .select({ id: schema.comicImages.id, characterId: schema.comicImages.characterId, key: schema.comicImages.imageKey, status: schema.comicImages.status, createdAt: schema.comicImages.createdAt })
      .from(schema.comicImages)
      .where(and(eq(schema.comicImages.kind, "sheet"), eq(schema.comicImages.styleId, styleId), eq(schema.comicImages.organizationId, ctx.organizationId)))
      .orderBy(desc(schema.comicImages.createdAt)),
  );
  const out = new Map<string, { id: string; key: string; status: string }>();
  for (const r of rows) {
    if (!r.characterId || !characterIds.includes(r.characterId)) continue;
    const have = out.get(r.characterId);
    if (!have || (have.status !== "accepted" && r.status === "accepted")) out.set(r.characterId, { id: r.id, key: r.key, status: r.status ?? "draft" });
  }
  return out;
}
