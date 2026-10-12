import "server-only";
import { GoogleAuth } from "google-auth-library";
import { googleCredentials } from "./google";

/**
 * Google Cloud Vision `images:annotate`, authenticated with the service account from
 * GOOGLE_APPLICATION_CREDENTIALS_JSON (the Cloud Vision API must be enabled on that project). Shared by the face
 * guard (`faces.ts`) and the watermark scan (`watermark-scan.ts`).
 */
const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
/** The JSON request is capped at 10 MB and base64 adds a third. */
export const VISION_MAX_BYTES = 7_000_000;

export type VisionVertex = { x?: number; y?: number };
export type VisionPoly = { vertices?: VisionVertex[] };
export type VisionResponse = {
  faceAnnotations?: Array<{ boundingPoly?: VisionPoly; detectionConfidence?: number }>;
  textAnnotations?: Array<{ description?: string; boundingPoly?: VisionPoly }>;
  logoAnnotations?: Array<{ description?: string; score?: number; boundingPoly?: VisionPoly }>;
  error?: { message?: string };
};

let auth: GoogleAuth | undefined;
async function accessToken() {
  const { credentials } = googleCredentials();
  auth ??= new GoogleAuth({ credentials, scopes: SCOPES });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("could not mint a Google access token");
  return token;
}

/** Annotate one picture with the given features. Throws on HTTP and API errors. */
export async function visionAnnotate(bytes: Buffer, features: Array<{ type: "FACE_DETECTION" | "TEXT_DETECTION" | "LOGO_DETECTION"; maxResults?: number }>): Promise<VisionResponse> {
  if (bytes.byteLength > VISION_MAX_BYTES) throw new Error(`picture too large for Cloud Vision (${Math.round(bytes.byteLength / 1e6)} MB)`);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: bytes.toString("base64") }, features }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Cloud Vision HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const first = ((await res.json()) as { responses?: VisionResponse[] }).responses?.[0];
  if (first?.error?.message) throw new Error(`Cloud Vision: ${first.error.message.slice(0, 300)}`);
  return first ?? {};
}
