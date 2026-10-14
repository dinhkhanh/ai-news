/**
 * Which stream yt-dlp takes from a video site, and how hard x264 works on it (always CRF 18).
 *
 * `full` (the default: the office Mac mini, or a NAS): the best stream up to 1080p class (shorter side ≤ 1080:
 * 1920×1080 landscape, 1080×1920 portrait; a 4K stream only multiplies the work, the frame is 1080 px wide) and
 * preset `medium`. A 120 s Facebook AV1 section takes an M2 about 80 s, a 10 min video about 7 min.
 *
 * `fast` (the media Lambda, the fallback when the Mac cannot be reached, ~2 vCPU and a 600 s limit): the smallest
 * stream at least 1080 px wide (1280×720 for landscape, still drawn 1080 wide) and preset `veryfast`, about a
 * fifth of the CPU, so a long section finishes instead of timing out. `WEB_VIDEO_PROFILE` overrides the choice.
 */
const mp4Video = (filter: string) => `bv*${filter}[ext=mp4]+ba[ext=m4a]`;
export const WEB_VIDEO_PROFILES = {
  full: { format: [mp4Video(""), "b[ext=mp4]", "b"].join("/"), sort: ["-S", "res:1080"], preset: "medium" },
  fast: { format: [mp4Video("[width>=1080][width<=1280]"), mp4Video("[width>=1080][width<=1920]"), mp4Video("[width>=1080]"), mp4Video(""), "b[ext=mp4]", "b"].join("/"), sort: [] as string[], preset: "veryfast" },
} as const;
export function webVideoProfile(env: NodeJS.ProcessEnv = process.env) {
  const pick = env.WEB_VIDEO_PROFILE === "fast" || env.WEB_VIDEO_PROFILE === "full" ? env.WEB_VIDEO_PROFILE : env.AWS_LAMBDA_FUNCTION_NAME ? "fast" : "full";
  return WEB_VIDEO_PROFILES[pick];
}
