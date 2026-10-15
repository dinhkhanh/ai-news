import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const YTDLP = process.env.YTDLP_PATH ?? "yt-dlp";

export async function run(bin: string, args: string[], opts: { maxBuffer?: number } = {}) {
  const { stdout, stderr } = await execFileP(bin, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 });
  return { stdout, stderr };
}

export const ffmpeg = (args: string[]) => run(FFMPEG, ["-hide_banner", "-nostats", "-y", ...args]);
export const ffprobe = (args: string[]) => run(FFPROBE, ["-hide_banner", ...args]);
/**
 * Current yt-dlp needs an external JS runtime for YouTube and only enables deno by
 * default, so point it at the Lambda's own Node. Lambda can only write under /tmp,
 * hence no cache dir.
 */
const YTDLP_BASE = ["--no-cache-dir", "--js-runtimes", `node:${process.execPath}`];

/**
 * Pauses before retrying a run YouTube turned away for now (`ytdlpTransient`). On the office line its bot check
 * and 429s come and go (about one lookup in six on 2026-10-15) and the same command passes seconds later; the
 * Lambda's datacenter IPs are refused every time, so it does not retry.
 */
export const YTDLP_RETRY_MS = [2000, 6000];
export const ytdlpRetryDelays = (env: NodeJS.ProcessEnv = process.env) => (env.AWS_LAMBDA_FUNCTION_NAME ? [] : YTDLP_RETRY_MS);

/** A refusal that can pass on a second try from the same IP: YouTube's "confirm you're not a bot", HTTP 429. */
export const ytdlpTransient = (message: string) => /confirm you.?re not a bot|HTTP Error 429|Too Many Requests/i.test(message);

/** A run that talks to YouTube: a YouTube page or a `ytsearch` query among its arguments. */
export const ytdlpTargetsYoutube = (args: string[]) => args.some((a) => /^(?:https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/|ytsearch\d*:)/i.test(a));

/**
 * Signed-in YouTube cookies on the office Mac (`YTDLP_COOKIES`, a Netscape file written by mac/youtube-cookies.sh):
 * YouTube runs only, so other sites never get them. Each run reads and updates its own copy (yt-dlp rewrites the file
 * on exit, and several runs overlap), and a run that succeeded puts its copy back, keeping the session YouTube refreshed.
 */
async function withYoutubeCookies<T>(args: string[], fn: (cookieArgs: string[]) => Promise<T>): Promise<T> {
  const file = process.env.YTDLP_COOKIES;
  if (!file || !ytdlpTargetsYoutube(args) || !existsSync(file)) return fn([]);
  const copy = `${file}.${process.pid}-${randomUUID()}`;
  await copyFile(file, copy);
  await chmod(copy, 0o600);
  try {
    const result = await fn(["--cookies", copy]);
    await rename(copy, file);
    return result;
  } finally {
    await rm(copy, { force: true });
  }
}

export async function ytdlp(args: string[], opts: { maxBuffer?: number } = {}) {
  for (const delay of [...ytdlpRetryDelays(), null]) {
    try {
      return await withYoutubeCookies(args, (cookieArgs) => run(YTDLP, [...YTDLP_BASE, ...cookieArgs, ...args], opts));
    } catch (e) {
      if (delay === null || !ytdlpTransient(ytdlpError(e))) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/** The useful part of a failed yt-dlp run: its last "ERROR:" line, else the last non-empty stderr line. */
export function ytdlpError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const lines = (err.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => /^ERROR:/i.test(l)) ?? lines[lines.length - 1];
  return (hit ?? err.message ?? String(e)).slice(0, 300);
}

/** Parse the JSON emitted by ffmpeg's loudnorm filter in print_format=json mode (last JSON object in stderr). */
export function parseLoudnormJson(stderr: string): Record<string, string> | null {
  const idx = stderr.lastIndexOf("{");
  if (idx < 0) return null;
  const end = stderr.indexOf("}", idx);
  if (end < 0) return null;
  try {
    // ffmpeg prints -inf for silent input, which is not valid JSON; keep it as a string.
    return JSON.parse(stderr.slice(idx, end + 1).replace(/:\s*-?inf\b/g, ': "-inf"')) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Parse `blackdetect` lines: "black_start:1.2 black_end:1.5 black_duration:0.3". */
export function parseBlackDetect(stderr: string) {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    out.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return out;
}

export function parseFps(rFrameRate: string | undefined) {
  if (!rFrameRate) return 0;
  const [n, d] = rFrameRate.split("/").map(Number);
  return d ? Number((n / d).toFixed(3)) : n;
}
