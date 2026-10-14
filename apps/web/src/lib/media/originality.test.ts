import { describe, expect, it } from "vitest";
import { brandSchema } from "@ai-news/video/schema";
import { editorDocSchema } from "./editor";
import { docShots, MAX_THIRD_PARTY_RUN_SEC, MAX_THIRD_PARTY_VIDEO_SHARE, originalityReport, providerSource, spreadThirdParty, thirdPartyVideoBudget, type TimedShot } from "./originality";

describe("rules", () => {
  it("allow at most half of the time and two 5 s shots in a row", () => {
    expect(MAX_THIRD_PARTY_VIDEO_SHARE).toBe(0.5);
    expect(MAX_THIRD_PARTY_RUN_SEC).toBe(10);
  });
});

describe("providerSource", () => {
  it("tells third-party footage, third-party stills, stock and our own media apart", () => {
    expect(providerSource("yt-dlp", "video")).toBe("third_party_video");
    expect(providerSource("yt-capture", "video")).toBe("third_party_video");
    expect(providerSource("url", "video")).toBe("third_party_video");
    expect(providerSource("url", "image")).toBe("third_party_still");
    expect(providerSource("article", "image")).toBe("third_party_still");
    expect(providerSource("related", "image")).toBe("third_party_still");
    expect(providerSource("pexels", "video")).toBe("stock");
    expect(providerSource("pixabay", "video")).toBe("stock");
    expect(providerSource("gemini_image", "image")).toBe("own");
    expect(providerSource("upload", "video")).toBe("own");
    expect(providerSource("something-new", "video")).toBeNull();
    expect(providerSource(null, "video")).toBeNull();
  });
});

const shot = (sceneId: string, n: number, source: TimedShot["source"], sec = 5): TimedShot => ({ sceneId, shot: n, sec, source });

describe("originalityReport", () => {
  it("measures the share of third-party footage and flags runs over 10 s", () => {
    const r = originalityReport([shot("s1", 0, "own"), shot("s2", 0, "third_party_video"), shot("s2", 1, "third_party_video"), shot("s3", 0, "third_party_video"), shot("s3", 1, "third_party_still")]);
    expect(r.totalSec).toBe(25);
    expect(r.thirdPartyVideoSec).toBe(15);
    expect(r.share).toBe(0.6);
    expect(r.longRuns).toEqual([{ sec: 15, from: { sceneId: "s2", shot: 0 }, to: { sceneId: "s3", shot: 0 } }]);
    expect(r.longestRun?.sec).toBe(15);
  });

  it("accepts footage interspersed with other pictures", () => {
    const r = originalityReport([shot("s1", 0, "third_party_video"), shot("s1", 1, "third_party_video"), shot("s2", 0, "stock"), shot("s2", 1, "third_party_video"), shot("s3", 0, "own"), shot("s3", 1, null)]);
    expect(r.share).toBe(0.5);
    expect(r.longRuns).toEqual([]);
    expect(r.longestRun?.sec).toBe(10);
  });

  it("has nothing to report for a video without footage", () => {
    expect(originalityReport([shot("s1", 0, "own")])).toEqual({ totalSec: 5, thirdPartyVideoSec: 0, share: 0, longRuns: [], longestRun: null });
    expect(originalityReport([]).share).toBe(0);
  });
});

describe("docShots", () => {
  const video = (key: string) => ({ kind: "video" as const, key, clipDurationSec: 5 });
  const doc = editorDocSchema.parse({
    title: "T",
    language: "vi",
    source: { name: null, url: "" },
    brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {} }),
    scenes: [
      { id: "s1", kind: "hook", onScreenText: "", voiceover: "a", durationSec: 3, voice: null, visual: video("web.mp4") },
      { id: "s2", kind: "body", onScreenText: "", voiceover: "b", durationSec: 8, voice: null, visual: video("stock.mp4"), shots: [{ kind: "solid" }] },
    ],
    music: null,
  });

  it("splits each scene's time between its shots and looks the source up by key", () => {
    const providers: Record<string, string> = { "web.mp4": "yt-dlp", "stock.mp4": "pexels" };
    expect(docShots(doc, (k) => providers[k])).toEqual([
      { sceneId: "s1", shot: 0, sec: 3, source: "third_party_video" },
      { sceneId: "s2", shot: 0, sec: 4, source: "stock" },
      { sceneId: "s2", shot: 1, sec: 4, source: "own" },
    ]);
  });
});

describe("thirdPartyVideoBudget", () => {
  it("is half of the shots minus the footage already placed, never negative", () => {
    expect(thirdPartyVideoBudget(10, 0)).toBe(5);
    expect(thirdPartyVideoBudget(9, 0)).toBe(4);
    expect(thirdPartyVideoBudget(10, 4)).toBe(1);
    expect(thirdPartyVideoBudget(10, 7)).toBe(0);
  });
});

describe("spreadThirdParty", () => {
  const isFootage = (x: string) => x.startsWith("w");

  it("puts another picture between footage that would run past 10 s, otherwise keeps the order", () => {
    expect(spreadThirdParty(["a", "w1", "w2", "w3", "s"], isFootage, 5, 0)).toEqual({ items: ["a", "w1", "w2", "s", "w3"], carryOut: 5 });
    expect(spreadThirdParty(["a", "w1", "s"], isFootage, 5, 0)).toEqual({ items: ["a", "w1", "s"], carryOut: 0 });
  });

  it("carries the run over from the previous scene", () => {
    expect(spreadThirdParty(["w1", "a"], isFootage, 5, 10)).toEqual({ items: ["a", "w1"], carryOut: 5 });
  });

  it("leaves a scene of nothing but footage as it is", () => {
    expect(spreadThirdParty(["w1", "w2", "w3"], isFootage, 5, 0)).toEqual({ items: ["w1", "w2", "w3"], carryOut: 15 });
  });
});
