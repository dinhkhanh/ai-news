import { describe, expect, it } from "vitest";
import { detectWatermark, iou, nearEdge, sampleTimes, storedWatermark, watermarkLabel, type FrameMarks, type MarkBox } from "./watermark";

const box = (x: number, y: number, w = 0.08, h = 0.04): MarkBox => ({ x, y, w, h });
const frame = (texts: Array<[string, MarkBox]> = [], logos: Array<[string, MarkBox]> = []): FrameMarks => ({ texts: texts.map(([text, b]) => ({ text, box: b })), logos: logos.map(([name, b]) => ({ name, box: b })) });

describe("geometry", () => {
  it("knows the edge band and box overlap", () => {
    expect(nearEdge(box(0.85, 0.05))).toBe(true); // top-right corner bug
    expect(nearEdge(box(0.45, 0.9))).toBe(true); // lower third
    expect(nearEdge(box(0.45, 0.45))).toBe(false); // middle of the picture
    expect(iou(box(0.1, 0.1), box(0.1, 0.1))).toBe(1);
    expect(iou(box(0.1, 0.1), box(0.5, 0.5))).toBe(0);
  });
});

describe("detectWatermark", () => {
  it("flags a short-video app's name or an @handle anywhere, in a single frame", () => {
    const v = detectWatermark([frame([["TikTok", box(0.4, 0.5)], ["@nguyen.van_a", box(0.4, 0.55)]])]);
    expect(v.watermarked).toBe(true);
    expect(v.marks.map((m) => [m.kind, m.label])).toEqual([["platform", "TikTok"], ["platform", "@nguyen.van_a"]]);
    expect(detectWatermark([frame([["CapCut:", box(0.1, 0.9)]])]).watermarked).toBe(true);
    expect(detectWatermark([frame([["抖音", box(0.05, 0.05)]])]).watermarked).toBe(true);
  });

  it("flags text that stays at the same place near the edge (a channel bug)", () => {
    const bug = box(0.86, 0.04);
    const v = detectWatermark([frame([["VTV24", bug], ["Hà", box(0.3, 0.4)]]), frame([["VTV24", bug], ["Nội", box(0.5, 0.6)]]), frame([["VTV24", { ...bug, x: 0.861 }]])]);
    expect(v.marks).toEqual([{ kind: "text", label: "VTV24", box: bug }]);
    expect(v.frames).toBe(3);
  });

  it("flags a logo that stays at the same place near the edge", () => {
    const bug = box(0.05, 0.05, 0.1, 0.08);
    expect(detectWatermark([frame([], [["CNN", bug]]), frame([], [["CNN", bug]])]).marks.map((m) => m.kind)).toEqual(["logo"]);
  });

  it("leaves text inside the picture, moving text and one-off edge text alone", () => {
    // A press-conference backdrop: same words in every frame, but in the middle.
    const middle = box(0.4, 0.4, 0.2, 0.05);
    expect(detectWatermark([frame([["BỘ", middle]]), frame([["BỘ", middle]]), frame([["BỘ", middle]])]).watermarked).toBe(false);
    // A sign the camera pans past: near the edge, but somewhere else each time.
    expect(detectWatermark([frame([["STOP", box(0.02, 0.3)]]), frame([["STOP", box(0.85, 0.6)]])]).watermarked).toBe(false);
    // Seen in one frame only.
    expect(detectWatermark([frame([["Reuters", box(0.85, 0.05)]]), frame()]).watermarked).toBe(false);
    expect(detectWatermark([frame(), frame(), frame()])).toEqual({ watermarked: false, marks: [], frames: 3 });
  });

  it("needs two frames before anything counts as persistent", () => {
    expect(detectWatermark([frame([["VTV24", box(0.86, 0.04)]])]).watermarked).toBe(false);
  });
});

describe("sampleTimes", () => {
  it("grabs early, middle and late frames", () => {
    expect(sampleTimes(10)).toEqual([1.5, 5, 8.5]);
    expect(sampleTimes(null)).toEqual([0.75, 2.5, 4.25]);
    expect(sampleTimes(1)).toEqual([0.5]);
  });
});

describe("storedWatermark / watermarkLabel", () => {
  it("reads a stored verdict and names its marks", () => {
    const v = { watermarked: true, marks: [{ kind: "platform" as const, label: "TikTok", box: box(0, 0) }, { kind: "platform" as const, label: "TikTok", box: box(0.5, 0.5) }, { kind: "text" as const, label: "VTV24", box: box(0.9, 0) }], frames: 3 };
    expect(storedWatermark({ watermark: v })).toEqual(v);
    expect(storedWatermark({ watermark: { watermarked: "yes" } })).toBeNull();
    expect(storedWatermark(null)).toBeNull();
    expect(watermarkLabel(v)).toBe("TikTok, VTV24");
  });
});
