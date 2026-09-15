/**
 * ai-news media Lambda: FFmpeg utilities that don't belong in Remotion.
 *   probe      – resolution / fps / duration / loudness / black frames + expectation checks (render QA gate)
 *   loudnorm   – EBU R128 two-pass normalisation (VO -16 LUFS, final mix -14 LUFS, -1 dBTP)
 *   duck       – mix music under voice with sidechain compression (-12 dB under VO)
 *   cover      – extract a cover frame as JPEG
 *   mix        – VO segments + music → normalised, ducked WAV mix (see mix.ts)
 *   web-video  – yt-dlp download + optional trim (behind the web_video_downloader flag in the app)
 * Runs as a container image (see Dockerfile) so ffmpeg/ffprobe/yt-dlp are on PATH.
 */
import type { Context } from "aws-lambda";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe, parseBlackDetect, parseFps, parseLoudnormJson, ytdlp } from "./ffmpeg.js";
import { mix } from "./mix.js";
import { download, upload } from "./r2.js";
import type { Check, MediaAction, MediaResult, ProbeResult } from "./types.js";

const DEFAULT_TARGET_LUFS = -14;
const DEFAULT_TRUE_PEAK = -1;

export async function probeFile(file: string): Promise<ProbeResult> {
  const { stdout } = await ffprobe(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const info = JSON.parse(stdout) as {
    format: { duration?: string; size?: string };
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; bit_rate?: string }>;
  };
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("no video stream");

  let integratedLufs: number | null = null;
  let truePeakDb: number | null = null;
  if (a) {
    const { stderr } = await ffmpeg(["-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
    const ln = parseLoudnormJson(stderr);
    if (ln) {
      integratedLufs = Number(ln.input_i);
      truePeakDb = Number(ln.input_tp);
    }
  }
  const { stderr: bd } = await ffmpeg(["-i", file, "-vf", "blackdetect=d=0.3:pic_th=0.98", "-an", "-f", "null", "-"]);

  return {
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: parseFps(v.r_frame_rate),
    durationSec: Number(info.format.duration ?? 0),
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
    audioBitrateKbps: a?.bit_rate ? Math.round(Number(a.bit_rate) / 1000) : null,
    integratedLufs,
    truePeakDb,
    blackFrames: parseBlackDetect(bd),
    sizeBytes: Number(info.format.size ?? 0),
  };
}

function evaluate(p: ProbeResult, expect: NonNullable<Extract<MediaAction, { action: "probe" }>["expect"]>) {
  const checks: Record<string, Check> = {
    resolution: { ok: p.width === expect.width && p.height === expect.height, expected: `${expect.width}x${expect.height}`, actual: `${p.width}x${p.height}` },
    fps: { ok: Math.abs(p.fps - expect.fps) < 0.01, expected: expect.fps, actual: p.fps },
    videoCodec: { ok: p.videoCodec === "h264", expected: "h264", actual: p.videoCodec },
    audioPresent: { ok: p.audioCodec === "aac", expected: "aac", actual: p.audioCodec },
    blackFrames: { ok: p.blackFrames.length === 0, expected: 0, actual: p.blackFrames.length },
  };
  if (expect.minDurationSec !== undefined) checks.minDuration = { ok: p.durationSec >= expect.minDurationSec, expected: `>=${expect.minDurationSec}`, actual: p.durationSec };
  if (expect.maxDurationSec !== undefined) checks.maxDuration = { ok: p.durationSec <= expect.maxDurationSec, expected: `<=${expect.maxDurationSec}`, actual: p.durationSec };
  if (expect.lufs !== undefined) checks.loudness = { ok: p.integratedLufs !== null && Math.abs(p.integratedLufs - expect.lufs) <= 1.5, expected: `${expect.lufs}±1.5 LUFS`, actual: p.integratedLufs };
  if (expect.truePeakDb !== undefined) checks.truePeak = { ok: p.truePeakDb !== null && p.truePeakDb <= expect.truePeakDb + 0.3, expected: `<=${expect.truePeakDb} dBTP`, actual: p.truePeakDb };
  return checks;
}

export async function handle(event: MediaAction, work: string): Promise<MediaResult> {
  switch (event.action) {
    case "probe": {
      const file = path.join(work, "in" + path.extname(event.input.key));
      await download(event.input.key, file);
      const probe = await probeFile(file);
      const checks = event.expect ? evaluate(probe, event.expect) : undefined;
      const passed = checks ? Object.values(checks).every((c) => c.ok) : true;
      return { ok: true, action: "probe", passed, probe, checks };
    }
    case "loudnorm": {
      const input = path.join(work, "in" + path.extname(event.input.key));
      const output = path.join(work, "out" + path.extname(event.output.key));
      await download(event.input.key, input);
      const I = event.targetLufs ?? DEFAULT_TARGET_LUFS;
      const TP = event.truePeak ?? DEFAULT_TRUE_PEAK;
      const pass1 = await ffmpeg(["-i", input, "-af", `loudnorm=I=${I}:TP=${TP}:LRA=11:print_format=json`, "-f", "null", "-"]);
      const m = parseLoudnormJson(pass1.stderr);
      if (!m) throw new Error("loudnorm pass 1 produced no measurement");
      const filter = `loudnorm=I=${I}:TP=${TP}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`;
      const isVideo = /\.(mp4|mov|mkv)$/i.test(input);
      const isWav = /\.wav$/i.test(output);
      await ffmpeg([
        "-i", input,
        "-af", filter,
        ...(isVideo ? ["-c:v", "copy", "-movflags", "+faststart"] : []),
        ...(isWav ? ["-c:a", "pcm_s16le"] : ["-c:a", "aac", "-b:a", "192k"]),
        "-ar", "48000",
        output,
      ]);
      await upload(output, event.output.key, isVideo ? "video/mp4" : isWav ? "audio/wav" : "audio/mp4");
      const probe = await probeFile(output).catch(() => undefined);
      return { ok: true, action: "loudnorm", passed: true, outputKey: event.output.key, probe };
    }
    case "duck": {
      const voice = path.join(work, "voice" + path.extname(event.input.voiceKey));
      const music = path.join(work, "music" + path.extname(event.input.musicKey));
      const output = path.join(work, "mix.m4a");
      await Promise.all([download(event.input.voiceKey, voice), download(event.input.musicKey, music)]);
      const duck = event.duckDb ?? -12;
      // sidechain: music compressed by voice; static gain so music sits `duck` dB under VO even when VO pauses briefly
      const filter = `[1:a]volume=${duck}dB[m];[m][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2,alimiter=limit=-1dB[out]`;
      await ffmpeg(["-i", voice, "-i", music, "-filter_complex", filter, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", output]);
      await upload(output, event.output.key, "audio/mp4");
      return { ok: true, action: "duck", passed: true, outputKey: event.output.key };
    }
    case "cover": {
      const input = path.join(work, "in" + path.extname(event.input.key));
      const output = path.join(work, "cover.jpg");
      await download(event.input.key, input);
      await ffmpeg(["-ss", String(event.atSec ?? 1), "-i", input, "-frames:v", "1", "-q:v", "2", output]);
      await upload(output, event.output.key, "image/jpeg");
      return { ok: true, action: "cover", passed: true, outputKey: event.output.key };
    }
    case "mix": {
      const r = await mix(event, work);
      return { ok: true, action: "mix", passed: true, ...r };
    }
    case "web-video": {
      const raw = path.join(work, "raw.mp4");
      await ytdlp(["-f", "bv*[height>=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4", "--no-playlist", "-o", raw, event.input.url]);
      let final = raw;
      if (event.trim) {
        final = path.join(work, "trim.mp4");
        await ffmpeg(["-ss", String(event.trim.startSec), "-to", String(event.trim.endSec), "-i", raw, "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", final]);
      }
      await upload(final, event.output.key, "video/mp4");
      const probe = await probeFile(final).catch(() => undefined);
      return { ok: true, action: "web-video", passed: true, outputKey: event.output.key, probe };
    }
    default: {
      const never: never = event;
      throw new Error(`unknown action ${JSON.stringify(never)}`);
    }
  }
}

export const handler = async (event: MediaAction, context?: Context): Promise<MediaResult> => {
  const started = Date.now();
  const work = await mkdtemp(path.join(process.env.WORK_DIR ?? tmpdir(), "media-"));
  try {
    const result = await handle(event, work);
    return { ...result, billedMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: "error", action: event?.action, requestId: context?.awsRequestId, message }));
    return { ok: false, action: event?.action, passed: false, error: message.slice(0, 4000), billedMs: Date.now() - started };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
