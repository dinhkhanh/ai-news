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
export const ytdlp = (args: string[]) => run(YTDLP, args);

/** Parse the JSON emitted by ffmpeg's loudnorm filter in print_format=json mode (last JSON object in stderr). */
export function parseLoudnormJson(stderr: string): Record<string, string> | null {
  const idx = stderr.lastIndexOf("{");
  if (idx < 0) return null;
  try {
    return JSON.parse(stderr.slice(idx)) as Record<string, string>;
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
