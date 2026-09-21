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
  /** web-video-search */
  videos?: WebVideoCandidate[];
  /** Per-target failures of a web-video-search (the call still succeeds). */
  warnings?: string[];
};
