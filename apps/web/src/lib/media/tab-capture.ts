/**
 * Browser-only: record a section of a YouTube video in the user's own tab.
 *
 * A web page cannot read YouTube's media bytes (cross-origin, no CORS) and the
 * media Lambda is bot-blocked by YouTube, so the fallback is to play the video
 * in YouTube's official embedded player and record that region of the tab:
 * `getDisplayMedia` (current tab) → Region Capture (`CropTarget`) onto the
 * player box → `MediaRecorder`. The traffic is the editor's normal YouTube
 * playback on their own connection. Chromium only (Chrome / Edge 104+).
 *
 * Limits, by design: it runs in real time, the tab must stay in front, and the
 * picture is what the screen shows (player size × device pixel ratio), which
 * the media Lambda then normalises to CFR H.264 (`transcode`).
 */

type CropTargetCtor = { fromElement(el: Element): Promise<unknown> };
type CroppableTrack = MediaStreamTrack & { cropTo(target: unknown): Promise<void> };
type YTPlayer = { getPlayerState(): number; getCurrentTime(): number; playVideo(): void; mute(): void; destroy(): void };
type YTNamespace = { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer };
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
    CropTarget?: CropTargetCtor;
  }
}

export type CaptureJob = { videoId: string; startSec: number; durationSec: number };
export type CaptureSession = { stream: MediaStream; track: CroppableTrack; close(): void };

/** Seconds of playback before the wanted start, so the player's title overlay has faded when recording begins. */
const PREROLL_SEC = 4;
const START_TIMEOUT_MS = 30_000;
const MIME_PREFERENCE = ["video/mp4;codecs=avc1.640028", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

const YT_ERRORS: Record<number, string> = { 2: "ID video không hợp lệ", 5: "trình phát HTML5 lỗi", 100: "video đã bị gỡ hoặc riêng tư", 101: "chủ video không cho nhúng", 150: "chủ video không cho nhúng" };

export function tabCaptureSupported(): { ok: boolean; reason: string | null } {
  if (typeof window === "undefined") return { ok: false, reason: "chỉ chạy trong trình duyệt" };
  if (!navigator.mediaDevices?.getDisplayMedia) return { ok: false, reason: "trình duyệt không hỗ trợ ghi màn hình" };
  if (!window.CropTarget) return { ok: false, reason: "cần Chrome hoặc Edge bản mới (Region Capture)" };
  if (typeof MediaRecorder === "undefined") return { ok: false, reason: "trình duyệt không hỗ trợ MediaRecorder" };
  return { ok: true, reason: null };
}

/**
 * Ask to capture THIS tab and crop the capture to `box`. Must be called
 * straight from a click handler (needs a user gesture) – do not await anything first.
 */
export async function openTabCapture(box: HTMLElement): Promise<CaptureSession> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser", frameRate: { ideal: 30 }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: false,
    // Chromium hints: offer the current tab directly and nothing else.
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "exclude",
  } as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0] as CroppableTrack;
  const close = () => stream.getTracks().forEach((t) => t.stop());
  try {
    if (track.getSettings().displaySurface !== "browser" || typeof track.cropTo !== "function") throw new Error("Hãy chọn chia sẻ chính thẻ (tab) này, không phải cửa sổ hay màn hình.");
    // cropTo rejects when the captured tab is not this one.
    await track.cropTo(await window.CropTarget!.fromElement(box));
  } catch (e) {
    close();
    throw e instanceof Error && e.message.startsWith("Hãy chọn") ? e : new Error("Không cắt được vùng ghi: hãy chọn chia sẻ chính thẻ (tab) này.");
  }
  return { stream, track, close };
}

let ytApi: Promise<YTNamespace> | undefined;
function loadYouTubeApi(): Promise<YTNamespace> {
  ytApi ??= new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => reject(new Error("Không tải được YouTube IFrame API (bị chặn?)"));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("YouTube IFrame API không phản hồi")), 20_000);
  });
  return ytApi;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Play `job` inside `box` (the element the session is cropped to) and return
 * the recording of `[startSec, startSec + durationSec)`.
 */
export async function recordYouTube(session: CaptureSession, box: HTMLElement, job: CaptureJob, onState: (label: string) => void): Promise<Blob> {
  const YT = await loadYouTubeApi();
  const mount = document.createElement("div");
  mount.style.cssText = "width:100%;height:100%";
  box.replaceChildren(mount);
  let failed: string | null = null;
  const player = await new Promise<YTPlayer>((resolve, reject) => {
    const p = new YT.Player(mount, {
      width: "100%",
      height: "100%",
      videoId: job.videoId,
      playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0, playsinline: 1, cc_load_policy: 0, start: Math.max(0, Math.floor(job.startSec - PREROLL_SEC)) },
      events: {
        onReady: () => {
          p.mute();
          p.playVideo();
          resolve(p);
        },
        onError: (e: { data: number }) => {
          failed = YT_ERRORS[e.data] ?? `lỗi YouTube ${e.data}`;
          reject(new Error(failed));
        },
      },
    });
    setTimeout(() => reject(new Error("trình phát YouTube không khởi động")), START_TIMEOUT_MS);
  });
  // A transparent shield keeps the pointer from waking the player's hover UI while recording.
  const shield = document.createElement("div");
  shield.style.cssText = "position:absolute;inset:0;z-index:2;cursor:none";
  box.appendChild(shield);
  try {
    onState("đợi video phát tới đoạn cần ghi…");
    const waitFrom = Date.now();
    while (!(player.getPlayerState() === 1 && player.getCurrentTime() >= job.startSec)) {
      if (failed) throw new Error(failed);
      if (session.track.readyState !== "live") throw new Error("đã dừng chia sẻ thẻ");
      if (Date.now() - waitFrom > START_TIMEOUT_MS + PREROLL_SEC * 1000) {
        // A hidden tab never starts YouTube playback; say so instead of blaming the network.
        throw new Error(document.visibilityState === "hidden" ? "thẻ đang bị ẩn nên video không phát: giữ thẻ này ở phía trước trong lúc ghi" : "video không phát (tự phát bị chặn, quảng cáo dài hoặc mạng chậm)");
      }
      await sleep(80);
    }
    const mimeType = MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const recorder = new MediaRecorder(session.stream, { mimeType, videoBitsPerSecond: 16_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
    recorder.start(1000);
    const endAt = job.startSec + job.durationSec + 0.4;
    const recFrom = Date.now();
    // Follow the video's own clock so buffering does not shorten the clip; give up if it stalls for long.
    while (player.getCurrentTime() < endAt) {
      if (session.track.readyState !== "live") throw new Error("đã dừng chia sẻ thẻ");
      if (Date.now() - recFrom > (job.durationSec * 2 + 15) * 1000) throw new Error("video bị dừng khi đang ghi");
      onState(`đang ghi ${Math.max(0, player.getCurrentTime() - job.startSec).toFixed(0)}/${job.durationSec} s – đừng đổi thẻ, đừng rê chuột vào video`);
      await sleep(100);
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || "video/webm").split(";")[0] });
    if (blob.size < 50_000) throw new Error("bản ghi rỗng");
    return blob;
  } finally {
    try {
      player.destroy();
    } catch {
      /* already gone */
    }
    box.replaceChildren();
  }
}
