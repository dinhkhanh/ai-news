import "server-only";
import type { Timeline } from "@ai-news/video/schema";
import { presignGet, resolveSrc } from "@/lib/r2";

/** Replace every R2 key in the timeline with a presigned URL (valid long enough for a Lambda render). */
export async function resolveTimelineSrcs(t: Timeline, expiresIn = 3 * 3600): Promise<Timeline> {
  const r = (k: string | null) => (k ? resolveSrc(k, expiresIn) : Promise.resolve(null));
  const visual = async (v: Timeline["scenes"][number]["visual"]) => (v.kind === "solid" ? v : { ...v, src: await resolveSrc(v.src, expiresIn) });
  const scenes = await Promise.all(
    t.scenes.map(async (s) => ({
      ...s,
      visual: await visual(s.visual),
      shots: await Promise.all((s.shots ?? []).map(async (sh) => ({ ...sh, visual: await visual(sh.visual) }))),
      voiceSrc: await r(s.voiceSrc),
    })),
  );
  const [mixSrc, voiceSrc, musicSrc, logoSrc, overlaySrc] = await Promise.all([r(t.audio.mixSrc), r(t.audio.voiceSrc), r(t.audio.musicSrc), r(t.brand.logoSrc), r(t.brand.overlaySrc)]);
  return { ...t, scenes, brand: { ...t.brand, logoSrc, overlaySrc }, audio: { ...t.audio, mixSrc, voiceSrc, musicSrc } };
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
