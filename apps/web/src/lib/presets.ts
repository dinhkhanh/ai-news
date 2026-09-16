import { DURATION_PRESETS, SCRIPT_TONES } from "@/lib/prompts/defaults";

/** Validates the duration/tone preset from a form (docs/PLAN.md §4.2 presets: 30/60/90 s, tone). */
export function parsePreset(fd: FormData) {
  const durationSec = Number(fd.get("durationSec") ?? 60);
  const tone = String(fd.get("tone") ?? "punchy").trim() || "punchy";
  if (!DURATION_PRESETS.includes(durationSec as (typeof DURATION_PRESETS)[number])) throw new Error("Pick a duration preset");
  if (!SCRIPT_TONES.some((t) => t.key === tone)) throw new Error("Unknown tone");
  return { durationSec, tone };
}
