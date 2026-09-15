/** Mirror of apps/web/src/lib/media-lambda.ts. Keep in sync. */
export type Expect = {
  width: number;
  height: number;
  fps: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  /** Set after loudnorm; omitted for raw renders. */
  lufs?: number;
  truePeakDb?: number;
};

export type MediaAction =
  | { action: "probe"; input: { key: string }; expect?: Expect }
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

export type Check = { ok: boolean; expected?: unknown; actual?: unknown };

export type MediaResult = {
  ok: boolean;
  action: MediaAction["action"];
  passed: boolean;
  probe?: ProbeResult;
  outputKey?: string;
  voiceKey?: string;
  integratedLufs?: number | null;
  checks?: Record<string, Check>;
  error?: string;
  billedMs?: number;
};
