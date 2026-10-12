/**
 * Originality rules: how much of a video may be someone else's footage.
 *
 * Meta's original content guidelines (Facebook / Instagram Reels, Business Help Center; tightened 2025-07 and
 * 2026-03) count a post as *unoriginal* when it re-uploads footage the Page did not make, or only adds minor
 * edits to it: captions, borders, logos, background music, a speed change, or a voice-over that just describes
 * what is on screen. Unoriginal posts are shown to fewer people, a Page that keeps posting them loses
 * recommendations and monetisation, and duplicate videos are matched and demoted automatically. Third-party
 * material is fine when it is *interspersed* in content the Page made and its own commentary stays the focus.
 * TikTok and YouTube Shorts down-rank reused content the same way.
 *
 * Meta publishes no numbers, so the limits below are this app's own conservative reading of "interspersed":
 * at most half of the running time is third-party footage, and never more than two shots of it in a row.
 * Our own material is what the app makes: the voice-over, motion graphics, AI stills, drawn photos, brand cards
 * and the editor's own uploads. News photos (article / other outlets) are stills under a Ken Burns move, our
 * headline and our commentary, which is the news-video norm, so the limits apply to video footage only.
 * Licensed stock (Pexels / Pixabay) is not counted either.
 *
 * Pure: shared by the build (`prepare-assets`), the editor's "Kiểm tra" panel (`editor-checks.ts`) and the tests.
 * The build applies these rules only while the flag `originality_guard` is on (default on).
 */
import { sceneShots, sceneVoiceMs, type EditorDoc, type EditorVisual } from "./editor";

/** Largest share of the running time that may show third-party video footage. */
export const MAX_THIRD_PARTY_VIDEO_SHARE = 0.5;
/** Longest stretch of third-party video footage in a row (two 5 s shots). */
export const MAX_THIRD_PARTY_RUN_SEC = 10;

export type OriginalityRules = { maxShare: number; maxRunSec: number };
export const ORIGINALITY_RULES: OriginalityRules = { maxShare: MAX_THIRD_PARTY_VIDEO_SHARE, maxRunSec: MAX_THIRD_PARTY_RUN_SEC };

/**
 * Where a shot's picture comes from:
 * - `third_party_video`: footage from video sites (yt-dlp, browser capture, a project's source video) or a clip imported from a URL;
 * - `third_party_still`: photos of the article, other outlets, or imported from a URL;
 * - `stock`: licensed stock (Pexels / Pixabay);
 * - `own`: made by the app or the editor (motion graphics, AI stills, solid cards, uploads).
 */
export type ShotSource = "third_party_video" | "third_party_still" | "stock" | "own";

const THIRD_PARTY_VIDEO_PROVIDERS = new Set(["yt-dlp", "yt-capture"]);
const THIRD_PARTY_STILL_PROVIDERS = new Set(["article", "related"]);
const STOCK_PROVIDERS = new Set(["pexels", "pixabay"]);
const OWN_PROVIDERS = new Set(["gemini_image", "upload"]);

/** Source of a picture / clip by its asset provider (`assets.provider`); null when the provider is unknown. */
export function providerSource(provider: string | null | undefined, kind: "video" | "image"): ShotSource | null {
  if (!provider) return null;
  if (THIRD_PARTY_VIDEO_PROVIDERS.has(provider)) return "third_party_video";
  if (THIRD_PARTY_STILL_PROVIDERS.has(provider)) return "third_party_still";
  if (STOCK_PROVIDERS.has(provider)) return "stock";
  if (OWN_PROVIDERS.has(provider)) return "own";
  // A file imported from any URL: someone else's unless shown otherwise.
  if (provider === "url") return kind === "video" ? "third_party_video" : "third_party_still";
  return null;
}

/** Source of one shot; graphics and solid cards are ours even over a backdrop clip (the graphic is the focus). */
export function shotSource(v: EditorVisual, providerOf: (key: string) => string | null | undefined): ShotSource | null {
  if (v.kind === "video" || v.kind === "image") return providerSource(providerOf(v.key), v.kind);
  return "own";
}

export type TimedShot = { sceneId: string; shot: number; sec: number; source: ShotSource | null };

/** Every shot of the document in order with its time on screen (a scene's time is split equally between its shots). */
export function docShots(doc: Pick<EditorDoc, "scenes">, providerOf: (key: string) => string | null | undefined): TimedShot[] {
  return doc.scenes.flatMap((s) => {
    const all = sceneShots(s);
    const sec = sceneVoiceMs(s) / 1000 / all.length;
    return all.map((v, shot) => ({ sceneId: s.id, shot, sec, source: shotSource(v, providerOf) }));
  });
}

export type ShotRef = { sceneId: string; shot: number };
export type FootageRun = { sec: number; from: ShotRef; to: ShotRef };

export type OriginalityReport = {
  totalSec: number;
  thirdPartyVideoSec: number;
  /** Share of the running time showing third-party video (0–1). */
  share: number;
  /** Stretches of third-party video longer than the rule allows, longest first. */
  longRuns: FootageRun[];
  /** Longest stretch of third-party video, null when there is none. */
  longestRun: FootageRun | null;
};

const round = (n: number) => Math.round(n * 100) / 100;

/** How much third-party footage a cut shows, and where it runs on too long. */
export function originalityReport(shots: TimedShot[], rules: OriginalityRules = ORIGINALITY_RULES): OriginalityReport {
  const totalSec = shots.reduce((a, s) => a + s.sec, 0);
  const runs: FootageRun[] = [];
  let open = false;
  for (const s of shots) {
    if (s.source !== "third_party_video") {
      open = false;
      continue;
    }
    const at = { sceneId: s.sceneId, shot: s.shot };
    const last = runs[runs.length - 1];
    if (open && last) {
      last.sec += s.sec;
      last.to = at;
    } else runs.push({ sec: s.sec, from: at, to: at });
    open = true;
  }
  const thirdPartyVideoSec = runs.reduce((a, r) => a + r.sec, 0);
  const sorted = runs.map((r) => ({ ...r, sec: round(r.sec) })).sort((a, b) => b.sec - a.sec);
  return {
    totalSec: round(totalSec),
    thirdPartyVideoSec: round(thirdPartyVideoSec),
    share: totalSec > 0 ? round(thirdPartyVideoSec / totalSec) : 0,
    // A little slack: shots are an equal split of the scene time, so two "5 s" shots can add up to 10.01 s.
    longRuns: sorted.filter((r) => r.sec > rules.maxRunSec + 0.5),
    longestRun: sorted[0] ?? null,
  };
}

/**
 * Build: which shots may show third-party footage, for a video that would otherwise be all of it (a `video`
 * project's own source video). Walks the shots in order and lets footage in while the stretch stays within
 * `maxRunSec` and the share so far within `maxShare`; the first eligible shot always gets it (the hook shows
 * what the video is about). `eligible` false = a shot that shows something else anyway (a motion graphic).
 */
export function thirdPartyVideoMask(shots: Array<{ sec: number; eligible: boolean }>, rules: OriginalityRules = ORIGINALITY_RULES): boolean[] {
  let used = 0;
  let elapsed = 0;
  let run = 0;
  let first = true;
  return shots.map(({ sec, eligible }) => {
    const ok = eligible && (run === 0 || run + sec <= rules.maxRunSec + 1e-6) && (first || used + sec <= rules.maxShare * (elapsed + sec) + 1e-6);
    elapsed += sec;
    if (ok) {
      used += sec;
      run += sec;
      first = false;
    } else run = 0;
    return ok;
  });
}

/** Build: how many shots of web video tier 2 may still place, after `alreadyUsed` shots of third-party footage. */
export function thirdPartyVideoBudget(totalShots: number, alreadyUsed: number, rules: OriginalityRules = ORIGINALITY_RULES): number {
  return Math.max(0, Math.floor(rules.maxShare * totalShots + 1e-9) - alreadyUsed);
}

/**
 * Build: reorder a scene's shots so third-party footage is interspersed with other pictures. Keeps the given
 * order (the sourcing tiers) except that a footage shot waits whenever showing it would make the stretch longer
 * than `maxRunSec`; `carryIn` is the stretch the previous scene ended on. A scene of nothing but footage keeps
 * its order (there is nothing to put between). Returns the stretch this scene ends on.
 */
export function spreadThirdParty<T>(items: T[], isFootage: (item: T) => boolean, shotSec: number, carryIn: number, maxRunSec = MAX_THIRD_PARTY_RUN_SEC): { items: T[]; carryOut: number } {
  const indexed = items.map((item, i) => ({ item, i, footage: isFootage(item) }));
  const footage = indexed.filter((x) => x.footage);
  const other = indexed.filter((x) => !x.footage);
  const out: T[] = [];
  let run = carryIn;
  while (footage.length || other.length) {
    // Next in the original order…
    const nextIsFootage = footage.length > 0 && (other.length === 0 || footage[0].i < other[0].i);
    // …unless the footage would run on too long and there is something else to show.
    const take = nextIsFootage && run + shotSec > maxRunSec + 1e-6 && other.length ? other.shift()! : nextIsFootage ? footage.shift()! : other.shift()!;
    run = take.footage ? run + shotSec : 0;
    out.push(take.item);
  }
  return { items: out, carryOut: run };
}
