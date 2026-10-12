import "server-only";
import { eq, sql } from "drizzle-orm";
import { imageSize } from "image-size";
import { nanoid } from "nanoid";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { recordUsageCost } from "@/lib/activity";
import { flagEnabled } from "@/lib/flags";
import { invokeMediaLambda } from "@/lib/media-lambda";
import { deleteObject, getObjectBuffer, r2Key } from "@/lib/r2";
import { googleCredentials } from "./google";
import { visionAnnotate, type VisionPoly } from "./vision";
import { detectWatermark, sampleTimes, storedWatermark, type FrameMarks, type MarkBox, type WatermarkVerdict } from "./watermark";

/**
 * Watermark scan of a downloaded clip (`watermark.ts` decides): three frames grabbed by the media Lambda (`cover`),
 * each read by Cloud Vision for words and logos, then the frames are deleted. The verdict is kept in
 * `assets.meta.watermark`, so a clip (and a web video reused across builds) is scanned once. Behind the
 * `originality_guard` flag; needs the Cloud Vision API like the face guard.
 */

/** Cloud Vision: text detection and logo detection, $1.50 per 1 000 images each. */
const USD_PER_FRAME = 0.003;
const MEDIA_LAMBDA_USD_PER_SEC = 0.00006;

export async function watermarkScanAvailable(): Promise<{ enabled: boolean; reason: string | null }> {
  if (!(await flagEnabled("originality_guard"))) return { enabled: false, reason: "cờ originality_guard tắt" };
  try {
    googleCredentials();
  } catch (e) {
    return { enabled: false, reason: (e as Error).message };
  }
  return { enabled: true, reason: null };
}

/** A Vision bounding polygon as a box normalised to the frame; null when degenerate. */
function boxOf(poly: VisionPoly | undefined, width: number, height: number): MarkBox | null {
  const xs = (poly?.vertices ?? []).map((v) => v.x ?? 0);
  const ys = (poly?.vertices ?? []).map((v) => v.y ?? 0);
  if (xs.length < 2) return null;
  const x0 = Math.max(0, Math.min(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const x1 = Math.min(width, Math.max(...xs));
  const y1 = Math.min(height, Math.max(...ys));
  if (x1 <= x0 || y1 <= y0) return null;
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  return { x: r4(x0 / width), y: r4(y0 / height), w: r4((x1 - x0) / width), h: r4((y1 - y0) / height) };
}

/** Words and logos in one frame (the first text annotation is the whole block, the rest are words). */
async function readFrame(bytes: Buffer): Promise<FrameMarks> {
  const size = imageSize(bytes);
  if (!size.width || !size.height) throw new Error("unknown frame size");
  const r = await visionAnnotate(bytes, [{ type: "TEXT_DETECTION" }, { type: "LOGO_DETECTION", maxResults: 10 }]);
  const { width, height } = size;
  return {
    texts: (r.textAnnotations ?? []).slice(1).flatMap((t) => {
      const box = boxOf(t.boundingPoly, width, height);
      return box && t.description ? [{ text: t.description, box }] : [];
    }),
    logos: (r.logoAnnotations ?? []).flatMap((l) => {
      const box = boxOf(l.boundingPoly, width, height);
      return box && l.description && (l.score ?? 0) >= 0.5 ? [{ name: l.description, box }] : [];
    }),
  };
}

/**
 * Scan one clip asset. Never throws: a clip that cannot be read is reported and treated as clean, as before the
 * scan existed. `cached` = the verdict was already stored on the asset.
 */
export async function scanClipWatermark(
  asset: { assetId: string; key: string; durationSec: number | null },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<{ verdict: WatermarkVerdict | null; costUsd: number; cached: boolean; error: string | null }> {
  let costUsd = 0;
  const frameKeys: string[] = [];
  try {
    const row = await withOrgContext(ctx, (tx) => tx.query.assets.findFirst({ where: eq(schema.assets.id, asset.assetId), columns: { meta: true } }));
    const known = storedWatermark(row?.meta);
    if (known) return { verdict: known, costUsd: 0, cached: true, error: null };

    const times = sampleTimes(asset.durationSec);
    let lambdaMs = 0;
    const frames = await Promise.all(
      times.map(async (atSec) => {
        const key = r2Key.media(ctx.organizationId, ctx.projectId, `tmp/wm-${asset.assetId}-${nanoid(6)}.jpg`);
        frameKeys.push(key);
        const res = await invokeMediaLambda({ action: "cover", input: { key: asset.key }, output: { key }, atSec });
        lambdaMs += res.billedMs ?? 0;
        if (!res.ok) throw new Error(`frame at ${atSec}s: ${res.error ?? "media Lambda failed"}`);
        return readFrame(await getObjectBuffer(key));
      }),
    );
    const lambdaUsd = (lambdaMs / 1000) * MEDIA_LAMBDA_USD_PER_SEC;
    costUsd = frames.length * USD_PER_FRAME + lambdaUsd;
    await recordUsageCost({ provider: "google_vision", resource: "TEXT_DETECTION+LOGO_DETECTION", units: frames.length, unitType: "images", costUsd: frames.length * USD_PER_FRAME, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { assetId: asset.assetId, purpose: "watermark" } });
    await recordUsageCost({ provider: "media_lambda", resource: "cover", units: lambdaMs / 1000, unitType: "seconds", costUsd: lambdaUsd, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { assetId: asset.assetId, purpose: "watermark" } });
    const verdict = detectWatermark(frames);
    await withOrgContext(ctx, (tx) =>
      tx
        .update(schema.assets)
        .set({ meta: sql`coalesce(${schema.assets.meta}, '{}'::jsonb) || ${JSON.stringify({ watermark: verdict })}::jsonb` })
        .where(eq(schema.assets.id, asset.assetId)),
    );
    return { verdict, costUsd, cached: false, error: null };
  } catch (e) {
    return { verdict: null, costUsd, cached: false, error: `${asset.key.split("/").pop()}: ${(e as Error).message.slice(0, 200)}` };
  } finally {
    await Promise.all(frameKeys.map((k) => deleteObject(k).catch(() => {})));
  }
}
