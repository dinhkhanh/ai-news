import "server-only";
import { nanoid } from "nanoid";
import { recordUsageCost } from "@/lib/activity";
import { invokeMediaLambda } from "@/lib/media-lambda";
import { r2Key } from "@/lib/r2";
import { audioSignature, voicePlacement, type EditorDoc } from "./editor";

/** Media Lambda: 3008 MB, ≈ $0.000049/s; rounded up for R2 traffic. */
const MEDIA_LAMBDA_USD_PER_SEC = 0.00006;

export type MixResult = { mixKey: string; voiceKey: string; integratedLufs: number | null; signature: string; costUsd: number };

/**
 * Mix the document's audio layout on the media Lambda (docs/PLAN.md §4.4–4.5):
 * VO segments at their scene offsets → −16 LUFS, music looped/faded/ducked
 * −12 dB under it, limiter. Shared by the pipeline build, editor saves and
 * scene regeneration so every timeline version has a mix for its own layout.
 */
export async function mixDocAudio(doc: EditorDoc, ctx: { userId: string; organizationId: string; projectId: string }, buildId = nanoid(8)): Promise<MixResult> {
  const { voice, durationSec } = voicePlacement(doc);
  if (voice.length === 0) throw new Error("Không có giọng đọc nào để trộn âm");
  const mixKey = r2Key.media(ctx.organizationId, ctx.projectId, `mix/${buildId}.wav`);
  const voiceKey = r2Key.media(ctx.organizationId, ctx.projectId, `mix/${buildId}-vo.wav`);
  const res = await invokeMediaLambda({
    action: "mix",
    input: { voice, music: doc.music ? { key: doc.music.key, gainDb: doc.music.gainDb, fadeOutSec: 1.5 } : null },
    output: { key: mixKey, voiceKey },
    durationSec,
    voiceLufs: -16,
    duckDb: -12,
  });
  if (!res.ok) throw new Error(`audio mix failed: ${res.error ?? "unknown"}`);
  const costUsd = ((res.billedMs ?? 0) / 1000) * MEDIA_LAMBDA_USD_PER_SEC;
  await recordUsageCost({ provider: "media_lambda", resource: "mix", units: (res.billedMs ?? 0) / 1000, unitType: "seconds", costUsd, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId });
  return { mixKey, voiceKey, integratedLufs: res.integratedLufs ?? null, signature: audioSignature(doc), costUsd };
}
