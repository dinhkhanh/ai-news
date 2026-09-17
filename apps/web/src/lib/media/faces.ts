import "server-only";
import { eq, sql } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import { imageSize } from "image-size";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { recordUsageCost } from "@/lib/activity";
import { flagEnabled } from "@/lib/flags";
import { getObjectBuffer } from "@/lib/r2";
import type { FaceBox, FrameFaces } from "./framing";
import { googleCredentials } from "./google";

/**
 * Face detection for the face guard (`framing.ts`): Google Cloud Vision
 * `FACE_DETECTION` on the still stored in R2, authenticated with the service
 * account from GOOGLE_APPLICATION_CREDENTIALS_JSON (the Cloud Vision API must
 * be enabled on that project). Behind the `face_guard` flag. The result is
 * kept in `assets.meta.frame`, so a picture is only ever analysed once and the
 * editor can re-run the pure guard in the browser.
 */
const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
/** Cloud Vision face detection: $1.50 per 1 000 images. */
const USD_PER_IMAGE = 0.0015;
/** The JSON request is capped at 10 MB and base64 adds a third. */
const MAX_BYTES = 7_000_000;

type Vertex = { x?: number; y?: number };
type AnnotateResponse = { responses?: Array<{ faceAnnotations?: Array<{ boundingPoly?: { vertices?: Vertex[] }; detectionConfidence?: number }>; error?: { message?: string } }> };

let auth: GoogleAuth | undefined;
async function accessToken() {
  const { credentials } = googleCredentials();
  auth ??= new GoogleAuth({ credentials, scopes: SCOPES });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("could not mint a Google access token");
  return token;
}

export async function faceGuardAvailable(): Promise<{ enabled: boolean; reason: string | null }> {
  if (!(await flagEnabled("face_guard"))) return { enabled: false, reason: "cờ face_guard tắt" };
  try {
    googleCredentials();
  } catch (e) {
    return { enabled: false, reason: (e as Error).message };
  }
  return { enabled: true, reason: null };
}

/** Faces in one picture, normalised to its size. Throws on unreadable pictures and API errors. */
export async function detectFaces(bytes: Buffer): Promise<FrameFaces> {
  if (bytes.byteLength > MAX_BYTES) throw new Error(`picture too large for face detection (${Math.round(bytes.byteLength / 1e6)} MB)`);
  const size = imageSize(bytes);
  if (!size.width || !size.height) throw new Error("unknown picture size");
  // Browsers rotate by EXIF, Vision reports raw pixels: the boxes would not line up.
  if ((size.orientation ?? 1) > 1) throw new Error(`EXIF orientation ${size.orientation} is not supported`);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: bytes.toString("base64") }, features: [{ type: "FACE_DETECTION", maxResults: 20 }] }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Cloud Vision HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const first = ((await res.json()) as AnnotateResponse).responses?.[0];
  if (first?.error?.message) throw new Error(`Cloud Vision: ${first.error.message.slice(0, 300)}`);
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const faces: FaceBox[] = (first?.faceAnnotations ?? []).flatMap((f) => {
    const xs = (f.boundingPoly?.vertices ?? []).map((v) => v.x ?? 0);
    const ys = (f.boundingPoly?.vertices ?? []).map((v) => v.y ?? 0);
    if (xs.length < 2) return [];
    const x0 = Math.max(0, Math.min(...xs));
    const y0 = Math.max(0, Math.min(...ys));
    const x1 = Math.min(size.width, Math.max(...xs));
    const y1 = Math.min(size.height, Math.max(...ys));
    if (x1 <= x0 || y1 <= y0) return [];
    return [{ x: r4(x0 / size.width), y: r4(y0 / size.height), w: r4((x1 - x0) / size.width), h: r4((y1 - y0) / size.height), confidence: r4(f.detectionConfidence ?? 0) }];
  });
  return { width: size.width, height: size.height, faces };
}

/**
 * Detect faces for one image asset, meter the call and remember the result on
 * the asset row. Never throws: a picture the guard cannot read is reported and
 * used unchecked (centred crop), as before the guard existed.
 */
export async function analyseAsset(
  asset: { assetId: string; key: string },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<{ frame: FrameFaces | null; costUsd: number; error: string | null }> {
  try {
    const frame = await detectFaces(await getObjectBuffer(asset.key));
    await recordUsageCost({ provider: "google_vision", resource: "FACE_DETECTION", units: 1, unitType: "images", costUsd: USD_PER_IMAGE, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { assetId: asset.assetId, faces: frame.faces.length } });
    await withOrgContext(ctx, (tx) =>
      tx
        .update(schema.assets)
        .set({ width: frame.width, height: frame.height, meta: sql`${schema.assets.meta} || ${JSON.stringify({ frame })}::jsonb` })
        .where(eq(schema.assets.id, asset.assetId)),
    );
    return { frame, costUsd: USD_PER_IMAGE, error: null };
  } catch (e) {
    return { frame: null, costUsd: 0, error: `${asset.key.split("/").pop()}: ${(e as Error).message.slice(0, 200)}` };
  }
}
