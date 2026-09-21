import "server-only";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { env } from "@/lib/env";

/**
 * Contract with packages/media-lambda (FFmpeg + yt-dlp). Keys are R2 object
 * keys in R2_BUCKET; the Lambda reads/writes R2 with its own credentials.
 */
export type MediaAction =
  | { action: "probe"; input: { key: string }; expect?: { width: number; height: number; fps: number; minDurationSec?: number; maxDurationSec?: number; lufs?: number; truePeakDb?: number } }
  | { action: "loudnorm"; input: { key: string }; output: { key: string }; targetLufs?: number; truePeak?: number }
  | { action: "duck"; input: { voiceKey: string; musicKey: string }; output: { key: string }; duckDb?: number }
  | { action: "cover"; input: { key: string }; output: { key: string }; atSec?: number }
  | {
      /** Voice segments placed at offsets → VO normalised to `voiceLufs`, music looped/faded/ducked under it → one WAV mix. */
      action: "mix";
      input: { voice: Array<{ key: string; atSec: number }>; music?: { key: string; gainDb?: number; fadeOutSec?: number } | null };
      output: { key: string; voiceKey?: string };
      durationSec: number;
      voiceLufs?: number;
      duckDb?: number;
    }
  | { action: "web-video"; input: { url: string }; output: { key: string }; trim?: { startSec: number; endSec: number } }
  /** Normalise an uploaded recording (e.g. a browser tab capture, WebM/VFR) to constant-30 fps H.264 MP4 without audio; optional trim. */
  | { action: "transcode"; input: { key: string }; output: { key: string }; trim?: { startSec: number; endSec: number } }
  /** yt-dlp metadata only: `ytsearch<limit>:<query>` on YouTube plus any explicit video-page URLs (TikTok, Facebook, Vimeo, …). */
  | { action: "web-video-search"; input: { query?: string; urls?: string[]; limit?: number } };

/** A video found on a video site (yt-dlp metadata), before any download. */
export type WebVideoCandidate = {
  id: string;
  url: string;
  title: string;
  site: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  uploader: string | null;
  viewCount: number | null;
  uploadDate: string | null;
  width: number | null;
  height: number | null;
  /** The post's caption / description (full metadata only; search results often have none). Older deployments omit it. */
  description?: string | null;
};


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
  voiceKey?: string;
  integratedLufs?: number | null;
  checks?: Record<string, { ok: boolean; expected?: unknown; actual?: unknown }>;
  error?: string;
  billedMs?: number;
  /** web-video-search */
  videos?: WebVideoCandidate[];
  /** Per-target failures of a web-video-search (the call still succeeds). */
  warnings?: string[];
};

let client: LambdaClient | undefined;

/**
 * Direct call of the media Lambda. Video downloads (`web-video`, yt-dlp on
 * YouTube / Facebook / TikTok…) are not accepted here: datacenter IPs are
 * bot-checked, so every download goes through `invokeWebVideo`, which prefers
 * the self-hosted box on an ISP line. Everything else (audio, probes, covers,
 * transcodes, yt-dlp *searches*) works from the Lambda.
 */
export async function invokeMediaLambda(payload: Exclude<MediaAction, { action: "web-video" }>): Promise<MediaResult> {
  return invokeLambdaRaw(payload);
}

async function invokeLambdaRaw(payload: MediaAction): Promise<MediaResult> {
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

/**
 * The only way to download from a video site. Downloads and page lookups go to the self-hosted API when one is configured
 * (`WEB_VIDEO_API_URL`, see packages/media-lambda/src/server.ts): it runs the
 * same handler on a regular ISP line, which YouTube does not bot-check, and
 * writes to the same R2 bucket. If the box cannot be reached at all the
 * Lambda is used, so a NAS outage degrades to the old behaviour instead of
 * failing the build; a yt-dlp error from the box is returned as is.
 */
export async function invokeWebVideo(payload: Extract<MediaAction, { action: "web-video" | "web-video-search" }>): Promise<MediaResult & { via: "nas" | "lambda" }> {
  const e = env();
  if (e.WEB_VIDEO_API_URL && e.WEB_VIDEO_API_TOKEN) {
    const started = Date.now();
    try {
      const res = await fetch(new URL("/invoke", e.WEB_VIDEO_API_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${e.WEB_VIDEO_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      const json = (await res.json().catch(() => null)) as (MediaResult & { error?: string }) | null;
      if (res.status === 429 || res.status >= 500 || !json) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, action: payload.action, passed: false, error: `web-video API: ${json.error ?? `HTTP ${res.status}`}`, via: "nas" };
      return { ...json, billedMs: 0, via: "nas" };
    } catch (err) {
      console.warn("[web-video] self-hosted API unreachable, using the Lambda", (err as Error).message, `${Date.now() - started} ms`);
    }
  }
  return { ...(await invokeLambdaRaw(payload)), via: "lambda" };
}
