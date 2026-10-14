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

/** A NAS that refused a connection (or never answered) is skipped this long, so every call does not wait for it again. */
const NAS_DOWN_MS = 3 * 60 * 1000;
/** How often a running NAS job is asked for its state. */
const JOB_POLL_MS = 3000;
/** The longest `invokeWebVideo` waits for a download before giving up on this call (functions stop at 300 s). */
export const WEB_VIDEO_WAIT_MS = 240_000;
let nasDownUntil = 0;

type WebVideoAction = Extract<MediaAction, { action: "web-video" }>;
type ViaResult = MediaResult & { via: "nas" | "lambda" };
/** A download: finished (or failed), or still running on the NAS as job `pending` (resume with `downloadWebVideo({ jobId })`). */
export type WebVideoDownload = ViaResult | { pending: string };

/** Connection-level failure (refused, unreachable, DNS, no answer in time): the box is down, not merely busy. */
const unreachable = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || /fetch failed|ECONN|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(`${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ""}`));

function nas() {
  const e = env();
  return e.WEB_VIDEO_API_URL && e.WEB_VIDEO_API_TOKEN ? { url: e.WEB_VIDEO_API_URL, token: e.WEB_VIDEO_API_TOKEN } : null;
}

async function nasRequest(path: string, init: { method: "GET" | "POST"; body?: unknown }, timeoutMs: number) {
  const box = nas()!;
  const res = await fetch(new URL(path, box.url), {
    method: init.method,
    headers: { Authorization: `Bearer ${box.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: string }) | null;
  return { status: res.status, json };
}

const markDown = (what: string, err: unknown, started: number) => {
  nasDownUntil = Date.now() + NAS_DOWN_MS;
  console.warn(`[web-video] self-hosted API unreachable (${what}), using the Lambda for ${NAS_DOWN_MS / 60_000} min`, (err as Error).message, `${Date.now() - started} ms`);
};

type JobView = { jobId: string; state: "queued" | "running" | "done"; result?: MediaResult };

/**
 * Download a section from a video site. On the self-hosted API (`WEB_VIDEO_API_URL`, packages/media-lambda/src/server.ts,
 * a regular ISP line that YouTube does not bot-check) it runs as a background job: started (or re-attached to: the
 * box keeps one job per section) and polled for up to `waitMs`. Still running then = `{ pending: jobId }`, which a
 * durable caller hands to its next step instead of dying at the function limit while the NAS encodes; a slow NAS
 * is never mistaken for a dead one. Only a box that cannot be reached at all falls back to the Lambda (and is
 * skipped for a few minutes). A box built before jobs existed (no `/jobs`) is called the old, blocking way.
 */
export async function downloadWebVideo(payload: WebVideoAction, opts: { jobId?: string | null; waitMs?: number } = {}): Promise<WebVideoDownload> {
  const deadline = Date.now() + (opts.waitMs ?? WEB_VIDEO_WAIT_MS);
  // A job already running is polled even if this instance thinks the box is down: it may well be back.
  if (nas() && (opts.jobId || Date.now() >= nasDownUntil)) {
    let jobId = opts.jobId ?? null;
    let resubmitted = false;
    const started = Date.now();
    const submit = async (): Promise<JobView | ViaResult | "lambda"> => {
      try {
        const r = await nasRequest("/jobs", { method: "POST", body: payload }, 15_000);
        if (r.status === 404 && !r.json?.jobId) return legacyInvoke(payload);
        if (r.status >= 500 || !r.json) return "lambda";
        if (r.status !== 202) return { ok: false, action: "web-video", passed: false, error: `web-video API: ${r.json.error ?? `HTTP ${r.status}`}`, via: "nas" };
        return r.json as unknown as JobView;
      } catch (e) {
        if (!unreachable(e)) throw e;
        markDown("start", e, started);
        return "lambda";
      }
    };
    const settle = (v: JobView): ViaResult | null => (v.state === "done" && v.result ? { ...v.result, billedMs: 0, via: "nas" } : null);

    let first: JobView | null = null;
    if (!jobId) {
      const s = await submit();
      if (s === "lambda") return lambdaFallback(payload);
      if ("via" in s) return s;
      first = s;
      jobId = s.jobId;
    }
    if (first && settle(first)) return settle(first)!;
    while (Date.now() + JOB_POLL_MS < deadline) {
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      try {
        const r = await nasRequest(`/jobs/${jobId}`, { method: "GET" }, 15_000);
        if (r.status === 404) {
          // The box restarted (jobs live in memory): ask again once, which starts it over.
          if (resubmitted) return { ok: false, action: "web-video", passed: false, error: "web-video API: the download job was lost twice (NAS restarting?)", via: "nas" };
          resubmitted = true;
          const s = await submit();
          if (s === "lambda") return lambdaFallback(payload);
          if ("via" in s) return s;
          jobId = s.jobId;
          if (settle(s)) return settle(s)!;
          continue;
        }
        if (r.status === 200 && r.json) {
          const done = settle(r.json as unknown as JobView);
          if (done) return done;
        }
        // Anything else (a proxy hiccup, a 5xx) is passing: keep asking until the deadline.
      } catch (e) {
        if (!unreachable(e)) throw e;
      }
    }
    return { pending: jobId! };
  }
  return lambdaFallback(payload);
}

/** Longest section the Lambda fallback takes on: it has ~2 vCPU, and the caller's function stops at 300 s. */
export const LAMBDA_MAX_SECTION_SEC = 120;

/**
 * The media Lambda instead of the video box (unreachable, or failing). A whole source video (minutes long) cannot
 * be encoded there before the calling function is cut off, which would only restart the download in a loop, so a
 * long section fails at once with a message naming the box instead.
 */
async function lambdaFallback(payload: WebVideoAction): Promise<ViaResult> {
  const sec = payload.trim ? payload.trim.endSec - payload.trim.startSec : Number.POSITIVE_INFINITY;
  if (sec > LAMBDA_MAX_SECTION_SEC) {
    return { ok: false, action: "web-video", passed: false, error: `máy tải video (Mac mini / NAS) không phản hồi, và đoạn ${Math.round(sec)} s quá dài cho máy dự phòng (tối đa ${LAMBDA_MAX_SECTION_SEC} s): kiểm tra máy rồi tải lại`, via: "lambda" };
  }
  return { ...(await invokeLambdaRaw(payload)), via: "lambda" };
}

/** A box without `/jobs`: one blocking request (a reverse proxy may cut it after 60 s), the Lambda when it fails. */
async function legacyInvoke(payload: WebVideoAction): Promise<ViaResult | "lambda"> {
  const started = Date.now();
  try {
    const r = await nasRequest("/invoke", { method: "POST", body: payload }, 280_000);
    if (r.status === 429 || r.status >= 500 || !r.json) return "lambda";
    if (r.status !== 200) return { ok: false, action: "web-video", passed: false, error: `web-video API: ${r.json.error ?? `HTTP ${r.status}`}`, via: "nas" };
    return { ...(r.json as unknown as MediaResult), billedMs: 0, via: "nas" };
  } catch (e) {
    if (unreachable(e)) markDown("invoke", e, started);
    return "lambda";
  }
}

/**
 * The only way to reach a video site: page lookups / searches, and downloads that may take up to
 * `WEB_VIDEO_WAIT_MS` (`downloadWebVideo` without a resumable job; a download still running then is an error
 * here). Both prefer the self-hosted API and fall back to the Lambda when it cannot be reached; a yt-dlp error
 * from the box is returned as is.
 */
export async function invokeWebVideo(payload: Extract<MediaAction, { action: "web-video" | "web-video-search" }>): Promise<MediaResult & { via: "nas" | "lambda" }> {
  if (payload.action === "web-video") {
    const r = await downloadWebVideo(payload);
    return "pending" in r ? { ok: false, action: "web-video", passed: false, error: `web-video API: still downloading after ${WEB_VIDEO_WAIT_MS / 1000} s (job ${r.pending})`, via: "nas" } : r;
  }
  if (nas() && Date.now() >= nasDownUntil) {
    const started = Date.now();
    try {
      const r = await nasRequest("/invoke", { method: "POST", body: payload }, 90_000);
      if (r.status !== 429 && r.status < 500 && r.json) {
        if (r.status !== 200) return { ok: false, action: payload.action, passed: false, error: `web-video API: ${r.json.error ?? `HTTP ${r.status}`}`, via: "nas" };
        return { ...(r.json as unknown as MediaResult), billedMs: 0, via: "nas" };
      }
      console.warn("[web-video] self-hosted API answered", r.status, "for a lookup, using the Lambda");
    } catch (e) {
      if (unreachable(e)) markDown("lookup", e, started);
      else console.warn("[web-video] self-hosted lookup failed, using the Lambda", (e as Error).message);
    }
  }
  return { ...(await invokeLambdaRaw(payload)), via: "lambda" };
}
