import "server-only";
import { randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { detectFaces } from "@/lib/media/faces";
import { USAGE_PROVIDER, vertexGenerateImage } from "@/lib/media/generate";
import { getObjectBuffer, putObject, r2Key } from "@/lib/r2";
import { imageCostUsd, imageModel } from "./models";
import type { Ctx } from "./service";

/**
 * Drawing for the comic studio (docs/COMIC.md §5, §6): one picture from the comic's image model with its reference
 * images, stored in R2 and in `comic_images`, metered (`usage_costs` + one `quota.comic_images` event). Panels also
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
  projectId: string;
  comicId?: string | null;
  panelId?: string | null;
  characterId?: string | null;
  styleId?: string | null;
  instruction?: string | null;
};

export type DrawnImage = { id: string; key: string; width: number; height: number; costUsd: number; faces?: { x: number; y: number; w: number; h: number }[] };

function keyFor(ctx: Ctx, r: DrawRequest, ext: string) {
  const name = `${randomUUID()}.${ext}`;
  if (r.kind === "panel" && r.comicId) return r2Key.comic(ctx.organizationId, r.comicId, `panels/${r.panelId ?? "x"}-${name}`);
  if (r.kind === "sheet") return r2Key.comicLibrary(ctx.organizationId, `sheets/${r.characterId ?? "x"}/${name}`);
  return r2Key.comicLibrary(ctx.organizationId, `samples/${r.styleId ?? "x"}/${name}`);
}

export async function drawComicImage(ctx: Ctx, r: DrawRequest): Promise<DrawnImage> {
  const model = imageModel(r.modelId);
  const refs = await Promise.all(r.refKeys.map(async (key) => ({ bytes: await getObjectBuffer(key), mime: mimeOf(key) })));
  const img = await vertexGenerateImage({ model: model.vertexId, prompt: r.prompt, refs, aspectRatio: r.aspect, imageSize: model.imageSize, projectId: r.projectId });
  const size = imageSize(img.bytes);
  const key = keyFor(ctx, r, extOf(img.mime));
  await putObject(key, img.bytes, img.mime);
  const costUsd = imageCostUsd(model.id, img.promptTokens);
  await recordUsageCost({
    provider: USAGE_PROVIDER,
    resource: model.vertexId,
    units: 1,
    unitType: "images",
    costUsd,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    meta: { comicId: r.comicId ?? null, kind: r.kind, panelId: r.panelId ?? null, characterId: r.characterId ?? null, refs: r.refKeys.length, tokens: img.tokens },
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
