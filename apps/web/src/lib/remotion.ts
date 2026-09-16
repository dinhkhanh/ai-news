import "server-only";
import { getRenderProgress, renderMediaOnLambda } from "@remotion/lambda-client";
import { env } from "@/lib/env";
import { r2Bucket, r2Endpoint } from "@/lib/r2";
import { isTransientRemotionSiteError, withRetry } from "@/lib/retry";

/** Fixed output spec (docs/PLAN.md §1). Never lowered for cost. */
export const OUTPUT_SPEC = {
  width: 1080,
  height: 1920,
  fps: 30,
  codec: "h264" as const,
  crf: 18,
  audioBitrate: "192k",
  audioCodec: "aac" as const,
  x264Preset: "medium" as const,
};

function awsCreds() {
  const e = env();
  if (!e.REMOTION_AWS_ACCESS_KEY_ID || !e.REMOTION_AWS_SECRET_ACCESS_KEY) {
    throw new Error("REMOTION_AWS_ACCESS_KEY_ID / REMOTION_AWS_SECRET_ACCESS_KEY are not set");
  }
  // @remotion/lambda-client reads REMOTION_AWS_* from process.env directly.
  return { region: e.AWS_REGION as Parameters<typeof renderMediaOnLambda>[0]["region"] };
}

function r2OutputProvider() {
  const e = env();
  if (!e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY) throw new Error("R2 credentials are not set");
  return {
    endpoint: r2Endpoint(),
    accessKeyId: e.R2_ACCESS_KEY_ID,
    secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    region: "auto",
    forcePathStyle: true,
  };
}

export type RenderHandle = { renderId: string; bucketName: string; functionName: string; region: string };

export async function startRender(opts: {
  composition: string;
  inputProps: Record<string, unknown>;
  outKey: string;
  durationInFrames?: number;
  webhookUrl?: string;
}): Promise<RenderHandle> {
  const e = env();
  const { region } = awsCreds();
  if (!e.REMOTION_FUNCTION_NAME || !e.REMOTION_SERVE_URL) {
    throw new Error("REMOTION_FUNCTION_NAME / REMOTION_SERVE_URL are not set (run packages/video deploy)");
  }
  // Remotion Lambda's headless browser occasionally hits a transient S3
  // AccessDenied while loading the site bundle to enumerate compositions
  // (observed 2026-09-16; every retry within seconds succeeded). `maxRetries`
  // below only covers frame-render chunks, not this one-time startup fetch,
  // so retry it here explicitly before failing the whole render.
  // NB: a *persistent* AccessDenied whose URL ends in `index.html\n/index.html`
  // is not transient — it means REMOTION_SERVE_URL has a trailing newline
  // (env() trims values now, but check the Vercel dashboard value too).
  const { renderId, bucketName } = await withRetry(
    () =>
      renderMediaOnLambda({
        region,
        functionName: e.REMOTION_FUNCTION_NAME!,
        serveUrl: e.REMOTION_SERVE_URL!,
        composition: opts.composition,
        inputProps: opts.inputProps,
        codec: OUTPUT_SPEC.codec,
        crf: OUTPUT_SPEC.crf,
        audioBitrate: OUTPUT_SPEC.audioBitrate,
        audioCodec: OUTPUT_SPEC.audioCodec,
        x264Preset: OUTPUT_SPEC.x264Preset,
        imageFormat: "jpeg",
        jpegQuality: 90,
        privacy: "no-acl",
        maxRetries: 2,
        framesPerLambda: 60,
        downloadBehavior: { type: "play-in-browser" },
        outName: {
          key: opts.outKey,
          bucketName: r2Bucket(),
          s3OutputProvider: r2OutputProvider(),
        },
      }),
    { attempts: 4, delayMs: 3000, isRetryable: isTransientRemotionSiteError },
  );
  return { renderId, bucketName, functionName: e.REMOTION_FUNCTION_NAME, region };
}

export async function getRenderStatus(h: RenderHandle) {
  return getRenderProgress({
    renderId: h.renderId,
    bucketName: h.bucketName,
    functionName: h.functionName,
    region: h.region as Parameters<typeof getRenderProgress>[0]["region"],
    s3OutputProvider: r2OutputProvider(),
  });
}
