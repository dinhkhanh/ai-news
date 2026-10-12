import { describe, expect, it } from "vitest";
import { brandSchema } from "@ai-news/video/schema";
import { editorDocSchema, sceneShots, type EditorDoc } from "./editor";
import { BUILTIN_CHECKS, fillMissingShots, replaceWithUnused, runChecks, unusedOptions, usedKeys, type CheckInput, type CheckOption } from "./editor-checks";

const img = (key: string) => ({ kind: "image" as const, key, kenBurns: true, focus: null, sketch: null, credit: null, assetId: null, thumbnailUrl: null });
const voice = (id: string, ms: number) => ({ key: `media/o/p/vo/${id}.wav`, durationMs: ms, words: [{ w: "a", s: 0, e: ms }] });

const doc: EditorDoc = editorDocSchema.parse({
  v: 1,
  title: "T",
  language: "vi",
  source: { name: null, url: "https://example.com/a" },
  brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {} }),
  scenes: [
    { id: "s1", kind: "hook", onScreenText: "", voiceover: "a", durationSec: 3, voice: voice("s1", 3000), visual: img("a.jpg") },
    // 9 s on one picture: needs 2 shots.
    { id: "s2", kind: "body", onScreenText: "x", voiceover: "b", durationSec: 9, voice: voice("s2", 9000), visual: img("b.jpg") },
    // Repeats a.jpg, and a placeholder colour shot.
    { id: "s3", kind: "body", onScreenText: "y", voiceover: "c", durationSec: 4, voice: voice("s3", 4000), visual: img("a.jpg"), shots: [{ kind: "solid" }] },
    { id: "s4", kind: "cta", onScreenText: "z", voiceover: "d", durationSec: 2, voice: voice("s4", 2000), visual: { kind: "solid" } },
  ],
  music: null,
  coverAtSec: null,
});

const opt = (key: string, extra: Partial<CheckOption> = {}): CheckOption => ({ assetId: key, key, kind: "image", durationSec: null, credit: null, thumbnailUrl: null, provider: "article", sceneId: null, frame: null, ...extra });
const options = [opt("a.jpg"), opt("b.jpg"), opt("ai.jpg", { provider: "gemini_image", sceneId: "s2" }), opt("c.jpg"), opt("d.jpg", { sceneId: "s2" })];

const input = (over: Partial<CheckInput> = {}): CheckInput => ({ doc, options, verdicts: { s2: { verdict: "supported", note: null, evidence: null }, s3: { verdict: "unsupported", note: "không có trong bài", evidence: null } }, mixUsable: true, durationSec: 20, platforms: [], hasLogo: false, ...over });

describe("usedKeys / unusedOptions", () => {
  it("lists where each picture is used and ranks unused options for a scene", () => {
    expect(usedKeys(doc)["a.jpg"]).toEqual(["s1", "s3"]);
    // The scene's own fetch first, AI stills after real pictures of the same rank.
    expect(unusedOptions(doc, options, "s2").map((o) => o.key)).toEqual(["d.jpg", "ai.jpg", "c.jpg"]);
  });
});

describe("runChecks", () => {
  const issues = runChecks(BUILTIN_CHECKS, input());
  const ids = issues.map((i) => i.id);

  it("finds the problems of the document, most severe first", () => {
    expect(ids).toContain("shot-hold:s2");
    expect(ids).toContain("repeat:s3");
    expect(ids).not.toContain("repeat:s1");
    expect(ids).toContain("solid:s3 #2");
    // A closing card on the brand colour is fine.
    expect(ids).not.toContain("solid:s4");
    expect(ids).toContain("hook-text:s1");
    expect(ids).toContain("audio:music");
    expect(issues[0]).toMatchObject({ id: "faith:s3", severity: "fix", fix: { kind: "rewrite", sceneId: "s3" } });
    expect(issues.at(-1)?.severity).toBe("info");
  });

  it("flags a missing faithfulness check and an unmixed preview as information only", () => {
    const more = runChecks(BUILTIN_CHECKS, input({ verdicts: null, mixUsable: false }));
    expect(more.find((i) => i.id === "faith:none")?.severity).toBe("info");
    expect(more.find((i) => i.id === "audio:mix")?.severity).toBe("info");
  });

  it("checks the length against the workspace's platforms", () => {
    expect(runChecks(BUILTIN_CHECKS, input({ durationSec: 100, platforms: ["youtube"] })).some((i) => i.id === "duration")).toBe(false);
    expect(runChecks(BUILTIN_CHECKS, input({ durationSec: 100, platforms: ["facebook", "youtube"] })).find((i) => i.id === "duration")?.detail).toContain("Facebook Reels");
  });

  it("survives a check that throws", () => {
    const bad = { id: "x", label: "x", run: () => { throw new Error("boom"); } };
    expect(runChecks([bad, ...BUILTIN_CHECKS], input()).length).toBe(issues.length);
  });
});

describe("fixes", () => {
  it("fills the missing shots of a scene with unused pictures", () => {
    const s2 = fillMissingShots(doc, options, "s2");
    expect(s2 && sceneShots(s2).map((v) => (v.kind === "image" ? v.key : v.kind))).toEqual(["b.jpg", "d.jpg"]);
  });

  it("replaces a repeated shot and keeps its hand-drawn look", () => {
    const drawn = { ...doc, scenes: doc.scenes.map((s) => (s.id === "s3" ? { ...s, visual: { ...img("a.jpg"), sketch: { style: "ink" as const } } } : s)) };
    const s3 = replaceWithUnused(drawn, options, "s3", 0);
    expect(s3?.visual).toMatchObject({ kind: "image", key: "c.jpg", sketch: { style: "ink" } });
  });

  it("returns null when nothing unused is left", () => {
    expect(replaceWithUnused(doc, [opt("a.jpg"), opt("b.jpg")], "s3", 1)).toBeNull();
  });
});
