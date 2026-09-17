import { execFile } from "node:child_process";
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
export const ytdlp = (args: string[], opts: { maxBuffer?: number } = {}) => run(YTDLP, [...YTDLP_BASE, ...args], opts);

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
