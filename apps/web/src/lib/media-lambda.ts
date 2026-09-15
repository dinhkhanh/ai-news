import "server-only";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { env } from "@/lib/env";

/**
 * Contract with packages/media-lambda (FFmpeg + yt-dlp). Keys are R2 object
 * keys in R2_BUCKET; the Lambda reads/writes R2 with its own credentials.
 */
export type MediaAction =
  | { action: "probe"; input: { key: string }; expect?: { width: number; height: number; fps: number; minDurationSec?: number; maxDurationSec?: number } }
  | { action: "loudnorm"; input: { key: string }; output: { key: string }; targetLufs?: number; truePeak?: number }
  | { action: "duck"; input: { voiceKey: string; musicKey: string }; output: { key: string }; duckDb?: number }
  | { action: "cover"; input: { key: string }; output: { key: string }; atSec?: number }
  | { action: "web-video"; input: { url: string }; output: { key: string }; trim?: { startSec: number; endSec: number } };

export type ProbeResult = {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  videoCodec: string;
  audioCodec: string | null;
  audioBitrateKbps: number | null;
  integratedLufs: number | null;
  truePeakDb: number | null;
  blackFrames: Array<{ start: number; end: number }>;
  sizeBytes: number;
};

export type MediaResult = {
  ok: boolean;
  action: MediaAction["action"];
  passed: boolean;
  probe?: ProbeResult;
  outputKey?: string;
  checks?: Record<string, { ok: boolean; expected?: unknown; actual?: unknown }>;
  error?: string;
  billedMs?: number;
};

let client: LambdaClient | undefined;

export async function invokeMediaLambda(payload: MediaAction): Promise<MediaResult> {
  const e = env();
  client ??= new LambdaClient({
    region: e.AWS_REGION,
    credentials:
      e.REMOTION_AWS_ACCESS_KEY_ID && e.REMOTION_AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: e.REMOTION_AWS_ACCESS_KEY_ID, secretAccessKey: e.REMOTION_AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
  const res = await client.send(
    new InvokeCommand({
      FunctionName: e.MEDIA_LAMBDA_FUNCTION_NAME,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
  if (res.FunctionError) {
    return { ok: false, action: payload.action, passed: false, error: `${res.FunctionError}: ${text.slice(0, 2000)}` };
  }
  try {
    return JSON.parse(text) as MediaResult;
  } catch {
    return { ok: false, action: payload.action, passed: false, error: `Unparseable Lambda response: ${text.slice(0, 500)}` };
  }
}
