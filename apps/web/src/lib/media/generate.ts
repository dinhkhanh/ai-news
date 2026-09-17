import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gte, sum } from "drizzle-orm";
import { GoogleAuth } from "google-auth-library";
import { db, schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { flagEnabled } from "@/lib/flags";
import { dailyLimit, usedToday } from "@/lib/quota";
import { putObject, r2Key } from "@/lib/r2";
import { readSecret } from "@/lib/vault";
import type { ChosenAsset } from "./broll";
import { googleCredentials } from "./google";

/**
 * AI-generated stills, the last tier of the visual priority
 * (`visual-plan.ts`): only for shots that the article, other outlets and
 * free stock could not cover. Gemini image model on Vertex AI
 * (`gemini-3.1-flash-image`, global endpoint, 9:16 at 1K), authenticated
 * with the service account from GOOGLE_APPLICATION_CREDENTIALS_JSON; the
 * project id comes from the `google_veo` integration secret (or the SA JSON).
 * Gated by the `ai_media` feature flag, the integration's monthly spend cap
 * and the user's daily `ai_media` quota (one `quota.ai_media` event per image).
 * Imagen predict endpoints were retired in June 2026, hence generateContent.
 */
export const AI_IMAGE_MODEL = "gemini-3.1-flash-image";
export const AI_IMAGE_PROVIDER = "gemini_image";
const USAGE_PROVIDER = "google_vertex";
/** 1120 output-image tokens at $60 / 1M (1K resolution) + a few hundred prompt tokens at $0.50 / 1M. */
const IMAGE_OUTPUT_USD = 0.0672;
const TEXT_INPUT_USD_PER_TOKEN = 0.5 / 1_000_000;
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export const AI_CREDIT: Record<"vi" | "en", string> = { vi: "Ảnh minh hoạ AI (Gemini)", en: "AI illustration (Gemini)" };

export type AiAvailability = { enabled: boolean; reason: string | null; remaining: number; projectId: string | null };

/** Whether this user may generate images now, and how many more today (Infinity when unmetered). */
export async function aiImagesAvailable(userId: string): Promise<AiAvailability> {
  const off = (reason: string): AiAvailability => ({ enabled: false, reason, remaining: 0, projectId: null });
  if (!(await flagEnabled("ai_media"))) return off("cờ ai_media tắt");
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, "google_veo") });
  if (!row?.enabled) return off("tích hợp Google Vertex chưa bật");
  let creds: ReturnType<typeof googleCredentials>;
  try {
    creds = googleCredentials();
  } catch (e) {
    return off((e as Error).message);
  }
  const projectId = (row.vaultRef ? await readSecret(row.vaultRef) : null)?.trim() || creds.projectId || null;
  if (!projectId) return off("thiếu Project ID (secret của tích hợp hoặc project_id trong SA JSON)");
  if (row.spendCapMonthlyUsd) {
    const cap = Number(row.spendCapMonthlyUsd);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [{ usd }] = await db
      .select({ usd: sum(schema.usageCosts.costUsd) })
      .from(schema.usageCosts)
      .where(and(eq(schema.usageCosts.provider, USAGE_PROVIDER), gte(schema.usageCosts.createdAt, monthStart)));
    if (cap > 0 && Number(usd ?? 0) >= cap) return off(`đã chạm mức chi tháng $${cap} của Google Vertex`);
  }
  const [limit, used] = await Promise.all([dailyLimit(userId, "ai_media"), usedToday(userId, "ai_media")]);
  const remaining = limit > 0 ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY;
  if (remaining === 0) return off(`hết hạn mức AI media hôm nay (${used}/${limit})`);
  return { enabled: true, reason: null, remaining, projectId };
}

/** Editorial, text-free, people-free illustration prompt built from the script's English terms. */
export function imagePrompt(scene: { onScreenText: string; brollTerms: string[] }, variant: number) {
  const subject = scene.brollTerms.map((t) => t.trim()).filter(Boolean).slice(0, 4).join(", ") || scene.onScreenText;
  const angles = ["wide establishing shot", "medium shot with shallow depth of field", "close-up detail shot", "high-angle overview"];
  return [
    `Photorealistic editorial news illustration for a vertical short video, 9:16 portrait, ${angles[variant % angles.length]}.`,
    `Subject: ${subject}.`,
    scene.onScreenText ? `Context of the scene: ${scene.onScreenText}.` : "",
    "Documentary look, natural lighting, muted realistic colours, plenty of clean space near the top and bottom.",
    "Strictly no text, captions, lettering, logos, watermarks or UI. No identifiable real people, public figures or faces in close-up. Nothing graphic or misleading.",
  ]
    .filter(Boolean)
    .join(" ");
}

type GenerateResponse = {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

let auth: GoogleAuth | undefined;
async function accessToken() {
  const { credentials } = googleCredentials();
  auth ??= new GoogleAuth({ credentials, scopes: SCOPES });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("could not mint a Google access token");
  return token;
}

/** One 9:16 image from Vertex AI; returns the bytes and the modelled cost. */
export async function generateImage(prompt: string, projectId: string): Promise<{ bytes: Buffer; mime: string; costUsd: number; tokens: number }> {
  const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${AI_IMAGE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "1K" }, candidateCount: 1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Vertex HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as GenerateResponse;
  if (json.promptFeedback?.blockReason) throw new Error(`prompt blocked: ${json.promptFeedback.blockReason}`);
  const cand = json.candidates?.[0];
  const part = cand?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData) throw new Error(`no image returned (${cand?.finishReason ?? "no candidate"})`);
  const tokens = json.usageMetadata?.totalTokenCount ?? 0;
  const costUsd = IMAGE_OUTPUT_USD + (json.usageMetadata?.promptTokenCount ?? 0) * TEXT_INPUT_USD_PER_TOKEN;
  return { bytes: Buffer.from(part.inlineData.data, "base64"), mime: part.inlineData.mimeType || "image/png", costUsd, tokens };
}

/**
 * Generate `count` stills for one scene, store them in R2 as `ai` assets and
 * meter cost + quota. Failures are collected per image so a build never dies
 * on the last tier; the caller decides what to do with the shortfall.
 */
export async function generateSceneImages(
  scene: { id: string; onScreenText: string; brollTerms: string[] },
  opts: { count: number; buildId: string; language: "vi" | "en"; projectId: string },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<{ assets: ChosenAsset[]; errors: string[]; costUsd: number }> {
  const { organizationId, projectId } = ctx;
  const assets: ChosenAsset[] = [];
  const errors: string[] = [];
  let costUsd = 0;
  const credit = AI_CREDIT[opts.language];
  for (let i = 0; i < opts.count; i++) {
    const prompt = imagePrompt(scene, i);
    try {
      const img = await generateImage(prompt, opts.projectId);
      const ext = img.mime === "image/jpeg" ? "jpg" : img.mime === "image/webp" ? "webp" : "png";
      const key = r2Key.media(organizationId, projectId, `ai/${opts.buildId}-${scene.id}-${i}.${ext}`);
      await putObject(key, img.bytes, img.mime);
      const hash = createHash("sha256").update(img.bytes).digest("hex");
      await recordUsageCost({ provider: USAGE_PROVIDER, resource: AI_IMAGE_MODEL, units: 1, unitType: "images", costUsd: img.costUsd, userId: ctx.userId, organizationId, projectId, meta: { sceneId: scene.id, tokens: img.tokens } });
      await logActivity({ actorId: ctx.userId, organizationId, projectId, type: "quota.ai_media", payload: { sceneId: scene.id, model: AI_IMAGE_MODEL } });
      costUsd += img.costUsd;
      const [row] = await withOrgContext(ctx, (tx) =>
        tx
          .insert(schema.assets)
          .values({
            organizationId, projectId, origin: "ai", provider: AI_IMAGE_PROVIDER, providerId: null, licence: "AI-generated (Google Gemini, SynthID watermark)", sourceUrl: null, r2Path: key, hash, mime: img.mime,
            width: 1080, height: 1920, sizeBytes: img.bytes.byteLength, searchTerm: scene.brollTerms.slice(0, 4).join(", "), sceneId: scene.id, selected: false, thumbnailUrl: null, attribution: credit,
            meta: { buildId: opts.buildId, model: AI_IMAGE_MODEL, prompt, variant: i },
          })
          .returning({ id: schema.assets.id }),
      );
      assets.push({ assetId: row.id, key, kind: "image", durationSec: null, credit, provider: AI_IMAGE_PROVIDER, thumbnailUrl: null });
    } catch (e) {
      errors.push(`${scene.id}#${i}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { assets, errors, costUsd };
}
