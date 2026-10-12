import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, sum } from "drizzle-orm";
import { imageSize } from "image-size";
import { db, schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { detectFaces } from "@/lib/media/faces";
import { USAGE_PROVIDER, vertexGenerateImage } from "@/lib/media/generate";
import { getObjectBuffer, putObject, r2Key } from "@/lib/r2";
import { readSecret } from "@/lib/vault";
import { imageCostUsd, imageModel, openaiImageCostUsd, openaiSize } from "./models";
import { openaiGenerateImage } from "./openai-image";
import type { Ctx } from "./service";

/**
 * Drawing for the comic studio (docs/COMIC.md §5, §6): one picture from the comic's image model with its reference
 * images (Gemini on Vertex or GPT Image on OpenAI, by the model's provider), stored in R2 and in `comic_images`,
 * metered (`usage_costs` under the provider's name + one `quota.comic_images` event). Panels also
 * get their faces detected (Cloud Vision), which the lettering keeps the balloons away from.
 */

const mimeOf = (key: string) => (/\.jpe?g$/i.test(key) ? "image/jpeg" : /\.webp$/i.test(key) ? "image/webp" : "image/png");
const extOf = (mime: string) => (mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png");
/** Cloud Vision face detection: $1.50 per 1 000 images (same rate as media/faces.ts). */
const VISION_USD = 0.0015;

export type DrawRequest = {
  kind: "panel" | "sheet" | "sample";
  modelId: string;
  prompt: string;
  refKeys: string[];
  aspect: string;
  /** Vertex project (from `comicDrawAccess`); null for OpenAI models. */
  projectId: string | null;
  comicId?: string | null;
  panelId?: string | null;
  characterId?: string | null;
  styleId?: string | null;
  instruction?: string | null;
  /** Vertex only: how long rate limits / server errors are tried again (`VertexImageRequest.retryWindowMs`); jobs set it, requests do not. */
  retryWindowMs?: number;
};

export type DrawnImage = { id: string; key: string; width: number; height: number; costUsd: number; faces?: { x: number; y: number; w: number; h: number }[] };

function keyFor(ctx: Ctx, r: DrawRequest, ext: string) {
  const name = `${randomUUID()}.${ext}`;
  if (r.kind === "panel" && r.comicId) return r2Key.comic(ctx.organizationId, r.comicId, `panels/${r.panelId ?? "x"}-${name}`);
  if (r.kind === "sheet") return r2Key.comicLibrary(ctx.organizationId, `sheets/${r.characterId ?? "x"}/${name}`);
  return r2Key.comicLibrary(ctx.organizationId, `samples/${r.styleId ?? "x"}/${name}`);
}

/** USD recorded under `provider` since the first of the month (UTC), for an integration's monthly spend cap. */
async function spentThisMonth(provider: string) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ usd }] = await db
    .select({ usd: sum(schema.usageCosts.costUsd) })
    .from(schema.usageCosts)
    .where(and(eq(schema.usageCosts.provider, provider), gte(schema.usageCosts.createdAt, monthStart)));
  return Number(usd ?? 0);
}

/** Whether GPT Image can be called: the `openai` integration is on, its key is in Vault, its monthly cap not reached. */
export async function openaiImageAccess(): Promise<{ ok: true; apiKey: string } | { ok: false; reason: string }> {
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, "openai") });
  if (!row?.enabled) return { ok: false, reason: "tích hợp OpenAI chưa bật" };
  const apiKey = (row.vaultRef ? await readSecret(row.vaultRef) : null)?.trim();
  if (!apiKey) return { ok: false, reason: "thiếu API key OpenAI (/admin/integrations)" };
  const cap = Number(row.spendCapMonthlyUsd ?? 0);
  if (cap > 0 && (await spentThisMonth("openai")) >= cap) return { ok: false, reason: `đã chạm mức chi tháng $${cap} của OpenAI` };
  return { ok: true, apiKey };
}

type Drawn = { bytes: Buffer; mime: string; costUsd: number; provider: string; meta: Record<string, unknown> };

async function draw(r: DrawRequest, refs: { bytes: Buffer; mime: string }[]): Promise<Drawn> {
  const model = imageModel(r.modelId);
  if (model.provider === "openai") {
    // The key is read here, not passed through the job's step state.
    const access = await openaiImageAccess();
    if (!access.ok) throw new Error(access.reason);
    const size = openaiSize(r.aspect);
    const img = await openaiGenerateImage({ apiKey: access.apiKey, model: model.apiId, prompt: r.prompt, refs, size, quality: model.quality ?? "medium" });
    return { bytes: img.bytes, mime: img.mime, costUsd: openaiImageCostUsd(model.id, img.usage, refs.length), provider: "openai", meta: { size, quality: model.quality ?? "medium", usage: img.usage } };
  }
  if (!r.projectId) throw new Error("thiếu Project ID của Google Vertex");
  const img = await vertexGenerateImage({ model: model.apiId, prompt: r.prompt, refs, aspectRatio: r.aspect, imageSize: model.imageSize ?? "1K", projectId: r.projectId, retryWindowMs: r.retryWindowMs });
  return { bytes: img.bytes, mime: img.mime, costUsd: imageCostUsd(model.id, img.promptTokens), provider: USAGE_PROVIDER, meta: { tokens: img.tokens } };
}

export async function drawComicImage(ctx: Ctx, r: DrawRequest): Promise<DrawnImage> {
  const model = imageModel(r.modelId);
  const refs = await Promise.all(r.refKeys.map(async (key) => ({ bytes: await getObjectBuffer(key), mime: mimeOf(key) })));
  const img = await draw(r, refs);
  const size = imageSize(img.bytes);
  const key = keyFor(ctx, r, extOf(img.mime));
  await putObject(key, img.bytes, img.mime);
  const costUsd = img.costUsd;
  await recordUsageCost({
    provider: img.provider,
    resource: model.apiId,
    units: 1,
    unitType: "images",
    costUsd,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    meta: { comicId: r.comicId ?? null, kind: r.kind, panelId: r.panelId ?? null, characterId: r.characterId ?? null, refs: r.refKeys.length, ...img.meta },
  });
  await logActivity({ actorId: ctx.userId, organizationId: ctx.organizationId, type: "quota.comic_images", payload: { comicId: r.comicId ?? null, kind: r.kind, model: model.id } });

  let faces: DrawnImage["faces"];
  if (r.kind === "panel") {
    try {
      const frame = await detectFaces(img.bytes);
      faces = frame.faces.filter((f) => f.confidence >= 0.5).map(({ x, y, w, h }) => ({ x, y, w, h }));
      await recordUsageCost({ provider: "google_vision", resource: "FACE_DETECTION", units: 1, unitType: "images", costUsd: VISION_USD, userId: ctx.userId, organizationId: ctx.organizationId, meta: { comicId: r.comicId, panelId: r.panelId, faces: faces.length } });
    } catch (e) {
      // Lettering falls back to the script's positions.
      console.warn("[comic] face detection failed", (e as Error).message);
    }
  }

  const [row] = await withOrgContext(ctx, (tx) =>
    tx
      .insert(schema.comicImages)
      .values({
        organizationId: ctx.organizationId,
        kind: r.kind,
        // Sheets belong to the character library, not to the comic they were drawn for: deleting the comic keeps them.
        comicId: r.kind === "panel" ? (r.comicId ?? null) : null,
        panelId: r.panelId ?? null,
        characterId: r.characterId ?? null,
        styleId: r.styleId ?? null,
        status: r.kind === "sheet" ? "draft" : null,
        imageKey: key,
        width: size.width ?? 0,
        height: size.height ?? 0,
        model: model.id,
        prompt: r.prompt,
        refs: r.refKeys,
        instruction: r.instruction ?? null,
        costUsd: costUsd.toFixed(6),
        meta: { aspect: r.aspect, ...(r.kind !== "panel" && r.comicId ? { comicId: r.comicId } : {}), ...(faces ? { faces } : {}) },
        createdBy: ctx.userId || null,
      })
      .returning({ id: schema.comicImages.id }),
  );
  return { id: row.id, key, width: size.width ?? 0, height: size.height ?? 0, costUsd, faces };
}
