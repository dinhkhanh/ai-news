import path from "node:path";
import { ffmpeg, parseLoudnormJson } from "./ffmpeg.js";
import { download, upload } from "./r2.js";
import type { MediaAction } from "./types.js";

type MixAction = Extract<MediaAction, { action: "mix" }>;

/** EBU R128 two-pass normalisation to a WAV (lossless intermediate). */
export async function loudnormToWav(input: string, output: string, I: number, TP = -1.5) {
  const pass1 = await ffmpeg(["-i", input, "-af", `loudnorm=I=${I}:TP=${TP}:LRA=11:print_format=json`, "-f", "null", "-"]);
  const m = parseLoudnormJson(pass1.stderr);
  if (!m) throw new Error(`loudnorm pass 1 produced no measurement: ${pass1.stderr.slice(-600)}`);
  if (!Number.isFinite(Number(m.input_i))) throw new Error(`loudnorm pass 1: input is silent (input_i=${m.input_i})`);
  const filter = `loudnorm=I=${I}:TP=${TP}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await ffmpeg(["-i", input, "-af", filter, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", output]);
}

export async function measureLufs(file: string) {
  const { stderr } = await ffmpeg(["-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
  const m = parseLoudnormJson(stderr);
  return m ? Number(m.input_i) : null;
}

/**
 * mix: place VO segments on one track, normalise to voiceLufs (-16 default),
 * loop + fade + duck music under it (sidechain, static `duckDb` under VO),
 * limit at -1 dBTP, pad/trim to exactly durationSec. Output: 48 kHz stereo WAV.
 */
export async function mix(event: MixAction, work: string) {
  const dur = event.durationSec;
  const voiceLufs = event.voiceLufs ?? -16;
  const duckDb = event.duckDb ?? -12;
  if (event.input.voice.length === 0) throw new Error("mix needs at least one voice segment");

  const voiceFiles: string[] = [];
  for (const [i, v] of event.input.voice.entries()) {
    const f = path.join(work, `v${i}${path.extname(v.key) || ".wav"}`);
    await download(v.key, f);
    voiceFiles.push(f);
  }
  // 1. VO track: delay each segment to its offset, sum, pad to duration.
  const inputs = voiceFiles.flatMap((f) => ["-i", f]);
  const delayed = event.input.voice.map((v, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round(v.atSec * 1000)}|${Math.round(v.atSec * 1000)}[d${i}]`).join(";");
  const sum = event.input.voice.map((_, i) => `[d${i}]`).join("");
  const voRaw = path.join(work, "vo_raw.wav");
  await ffmpeg([...inputs, "-filter_complex", `${delayed};${sum}amix=inputs=${voiceFiles.length}:normalize=0:duration=longest,apad=whole_dur=${dur},atrim=0:${dur}[vo]`, "-map", "[vo]", "-c:a", "pcm_s16le", voRaw]);
  const vo = path.join(work, "vo.wav");
  await loudnormToWav(voRaw, vo, voiceLufs);

  // 2. Music under VO.
  const out = path.join(work, "mix.wav");
  if (event.input.music) {
    const music = path.join(work, `music${path.extname(event.input.music.key) || ".mp3"}`);
    await download(event.input.music.key, music);
    const fade = event.input.music.fadeOutSec ?? 1.5;
    const gain = event.input.music.gainDb ?? duckDb;
    const filter = [
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${dur},afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, dur - fade)}:d=${fade},volume=${gain}dB[m]`,
      `[m][0:a]sidechaincompress=threshold=0.03:ratio=6:attack=25:release=450[md]`,
      `[0:a][md]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89:level=false[out]`,
    ].join(";");
    await ffmpeg(["-i", vo, "-stream_loop", "-1", "-i", music, "-filter_complex", filter, "-map", "[out]", "-t", String(dur), "-c:a", "pcm_s16le", out]);
  } else {
    await ffmpeg(["-i", vo, "-af", "alimiter=limit=0.89:level=false", "-c:a", "pcm_s16le", out]);
  }
  await upload(out, event.output.key, "audio/wav");
  if (event.output.voiceKey) await upload(vo, event.output.voiceKey, "audio/wav");
  const integratedLufs = await measureLufs(out).catch(() => null);
  return { outputKey: event.output.key, voiceKey: event.output.voiceKey, integratedLufs };
}
