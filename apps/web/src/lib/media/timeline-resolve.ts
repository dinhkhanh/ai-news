import "server-only";
import type { Timeline } from "@ai-news/video/schema";
import { presignGet, resolveSrc } from "@/lib/r2";

/** Replace every R2 key in the timeline with a presigned URL (valid long enough for a Lambda render). */
export async function resolveTimelineSrcs(t: Timeline, expiresIn = 3 * 3600): Promise<Timeline> {
  const r = (k: string | null) => (k ? resolveSrc(k, expiresIn) : Promise.resolve(null));
  const scenes = await Promise.all(
    t.scenes.map(async (s) => ({
      ...s,
      visual: s.visual.kind === "solid" ? s.visual : { ...s.visual, src: await resolveSrc(s.visual.src, expiresIn) },
      voiceSrc: await r(s.voiceSrc),
    })),
  );
  const [mixSrc, voiceSrc, musicSrc, logoSrc] = await Promise.all([r(t.audio.mixSrc), r(t.audio.voiceSrc), r(t.audio.musicSrc), r(t.brand.logoSrc)]);
  return { ...t, scenes, brand: { ...t.brand, logoSrc }, audio: { ...t.audio, mixSrc, voiceSrc, musicSrc } };
}

/** Presign a set of keys for browser playback (editor preview). Failures are skipped. */
export async function presignMap(keys: Iterable<string>, expiresIn = 3600): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    [...new Set(keys)].filter(Boolean).map(async (k) => {
      try {
        out[k] = /^https?:\/\//.test(k) ? k : await presignGet(k, expiresIn);
      } catch (e) {
        console.warn("[resolve] presign failed", k, e);
      }
    }),
  );
  return out;
}
