import { describe, expect, it } from "vitest";
import { brandSchema } from "@ai-news/video/schema";
import { audioSignature, buildFromDoc, describeChanges, docFromTimeline, docKeys, editorDocSchema, GAP_MS, LEAD_MS, moveScene, removeShot, replaceTailShots, sceneCaptions, setCaptionText, setShot, shotsMissing, TAIL_MS, voicePlacement, type EditorDoc, type EditorVisual } from "./editor";
import { layoutShots, shotsNeeded } from "./timeline";

const words = (text: string, ms: number) => {
  const ws = text.split(" ");
  const step = ms / ws.length;
  return ws.map((w, i) => ({ w, s: Math.round(i * step), e: Math.round((i + 1) * step) }));
};

const doc: EditorDoc = editorDocSchema.parse({
  v: 1,
  title: "Metro số 1",
  language: "vi",
  source: { name: "VnExpress", url: "https://vnexpress.net/x" },
  brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {} }),
  scenes: [
    { id: "s1", kind: "hook", onScreenText: "Metro kéo dài", voiceover: "Sáng nay thành phố công bố kế hoạch.", brollTerms: ["metro"], durationSec: 3, voice: { key: "media/o/p/vo/b1-s1.wav", durationMs: 3000, words: words("Sáng nay thành phố công bố kế hoạch.", 3000) }, visual: { kind: "video", key: "media/o/p/broll/b1-s1.mp4", clipDurationSec: 8, trimStartSec: 0, credit: "Video: Pexels", assetId: null, thumbnailUrl: null }, holdMs: 0, captions: null },
    { id: "s2", kind: "body", onScreenText: "Khởi công 2027", voiceover: "Tuyến mới dài mười hai ki lô mét.", brollTerms: [], durationSec: 2.5, voice: { key: "media/o/p/vo/b1-s2.wav", durationMs: 2500, words: words("Tuyến mới dài mười hai ki lô mét.", 2500) }, visual: { kind: "image", key: "media/o/p/aroll/b1-0.jpg", kenBurns: true, focus: null, credit: "Ảnh: VnExpress", assetId: null, thumbnailUrl: null }, holdMs: 0, captions: null },
    { id: "s3", kind: "cta", onScreenText: "", voiceover: "Theo dõi để cập nhật.", brollTerms: [], durationSec: 1.5, voice: { key: "media/o/p/vo/b1-s3.wav", durationMs: 1500, words: words("Theo dõi để cập nhật.", 1500) }, visual: { kind: "solid" }, holdMs: 0, captions: null },
  ],
  music: { key: "media/o/p/music/b1.mp3", gainDb: -12, attribution: "Nhạc: Mubert", title: "Mubert abc", source: "mubert", licence: "Mubert" },
  coverAtSec: null,
});

describe("buildFromDoc", () => {
  it("lays scenes out with lead/gap/tail and stores per-scene voice keys", () => {
    const { timeline, timings, durationSec } = buildFromDoc(doc, { mixKey: "media/o/p/mix/b1.wav", voiceKey: null });
    expect(timeline.scenes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(timings[0].atSec).toBe(LEAD_MS / 1000);
    expect(timings[1].atSec).toBeCloseTo((LEAD_MS + 3000 + GAP_MS) / 1000, 5);
    expect(durationSec).toBeCloseTo((LEAD_MS + 3000 + GAP_MS + 2500 + GAP_MS + 1500 + TAIL_MS) / 1000, 5);
    expect(timeline.scenes[0].voiceSrc).toBe("media/o/p/vo/b1-s1.wav");
    expect(timeline.audio.mixSrc).toBe("media/o/p/mix/b1.wav");
    expect(timeline.captions.length).toBeGreaterThan(2);
    expect(timeline.attribution).toEqual(["Video: Pexels", "Ảnh: VnExpress", "Nhạc: Mubert"]);
  });
  it("keeps trim and hold and shifts later scenes", () => {
    const edited: EditorDoc = { ...doc, scenes: doc.scenes.map((s, i) => (i === 0 ? { ...s, holdMs: 1000, visual: { ...s.visual, trimStartSec: 2 } as EditorDoc["scenes"][0]["visual"] } : s)) };
    const a = buildFromDoc(doc, null);
    const b = buildFromDoc(edited, null);
    expect(b.timings[1].atSec).toBeCloseTo(a.timings[1].atSec + 1, 5);
    expect(b.timeline.scenes[0].visual).toMatchObject({ kind: "video", trimStartSec: 2 });
    expect(b.timeline.audio.mixSrc).toBeNull();
    expect(b.timeline.durationFrames).toBe(a.timeline.durationFrames + 30);
  });
});

describe("shots", () => {
  const img = (n: number): EditorVisual => ({ kind: "image", key: `media/o/p/aroll/b1-${n}.jpg`, kenBurns: true, focus: null, credit: "Ảnh: VnExpress", assetId: null, thumbnailUrl: null });
  it("needs one shot per 5 s", () => {
    expect(shotsNeeded(3000)).toBe(1);
    expect(shotsNeeded(5000)).toBe(1);
    expect(shotsNeeded(5001)).toBe(2);
    expect(shotsNeeded(12_000)).toBe(3);
  });
  it("splits the scene equally between shots, solid when there is nothing", () => {
    const shots = layoutShots([{ kind: "image", key: "a", credit: null }, { kind: "video", key: "b", clipDurationSec: 4, trimStartSec: 1, credit: "Video: Pexels" }, { kind: "image", key: "c", kenBurns: false, credit: null }], 301);
    expect(shots.map((s) => [s.from, s.durationFrames])).toEqual([[0, 100], [100, 101], [201, 100]]);
    expect(shots[1].visual).toMatchObject({ kind: "video", trimStartSec: 1 });
    expect(shots[2].visual).toMatchObject({ kind: "image", kenBurns: false });
    expect(layoutShots([null], 90)).toEqual([{ from: 0, durationFrames: 90, visual: { kind: "solid" }, credit: null }]);
  });
  it("builds scene shots into the timeline and collects every credit and key", () => {
    const withShots: EditorDoc = { ...doc, scenes: doc.scenes.map((s, i) => (i === 1 ? { ...s, voice: { ...s.voice!, durationMs: 11_000 }, shots: [img(1), img(2)] } : s)) };
    const { timeline } = buildFromDoc(withShots, null);
    expect(timeline.scenes[1].shots.length).toBe(3);
    expect(timeline.scenes[1].shots.map((sh) => sh.from + sh.durationFrames).at(-1)).toBe(timeline.scenes[1].durationFrames);
    expect(timeline.scenes[1].visual).toMatchObject({ kind: "image", src: "media/o/p/aroll/b1-0.jpg" });
    expect(timeline.scenes[0].shots.length).toBe(1);
    expect(docKeys(withShots)).toContain("media/o/p/aroll/b1-2.jpg");
    expect(shotsMissing(withShots.scenes[1])).toBe(0);
    expect(shotsMissing({ ...withShots.scenes[1], shots: [] })).toBe(2);
    // Round trip through the stored document keeps the shots.
    expect(docFromTimeline(timeline, { doc: withShots }).scenes[1].shots.length).toBe(2);
  });
  it("edits shots: replace, remove, promote", () => {
    const scene = { ...doc.scenes[1], shots: [img(1), img(2)] };
    expect(setShot(scene, 2, img(9)).shots[1]).toEqual(img(9));
    expect(setShot(scene, 0, img(9)).visual).toEqual(img(9));
    const removed = removeShot(scene, 0);
    expect(removed.visual).toEqual(img(1));
    expect(removed.shots).toEqual([img(2)]);
    expect(removeShot(doc.scenes[1], 0)).toBe(doc.scenes[1]);
    expect(describeChanges(doc, { ...doc, scenes: doc.scenes.map((s, i) => (i === 1 ? scene : s)) })).toContain("s2: 3 cảnh quay");
  });
});

describe("audio signature + placement", () => {
  it("changes only when the mix would change", () => {
    const sig = audioSignature(doc);
    expect(audioSignature({ ...doc, scenes: doc.scenes.map((s) => ({ ...s, onScreenText: "x" })) })).toBe(sig);
    expect(audioSignature({ ...doc, coverAtSec: 2 })).toBe(sig);
    expect(audioSignature(moveScene(doc, 0, 1))).not.toBe(sig);
    expect(audioSignature({ ...doc, music: null })).not.toBe(sig);
    expect(audioSignature({ ...doc, scenes: doc.scenes.map((s, i) => (i === 1 ? { ...s, holdMs: 500 } : s)) })).not.toBe(sig);
  });
  it("places voice segments at scene offsets", () => {
    const p = voicePlacement(moveScene(doc, 2, 0));
    expect(p.voice[0]).toEqual({ key: "media/o/p/vo/b1-s3.wav", atSec: LEAD_MS / 1000 });
    expect(p.voice[1].atSec).toBeCloseTo((LEAD_MS + 1500 + GAP_MS) / 1000, 5);
  });
});

describe("captions", () => {
  it("edits one chunk's text and re-spreads its words over the same span", () => {
    const chunks = sceneCaptions(doc.scenes[0]);
    const edited = setCaptionText(chunks[0], "Sáng nay, TP.HCM");
    expect(edited.text).toBe("Sáng nay, TP.HCM");
    expect(edited.words.length).toBe(3);
    expect(edited.startMs).toBe(chunks[0].startMs);
    expect(edited.words.at(-1)!.e).toBeLessThanOrEqual(chunks[0].endMs);
    const scene = { ...doc.scenes[0], captions: chunks.map((c, i) => (i === 0 ? edited : c)) };
    const built = buildFromDoc({ ...doc, scenes: [scene, ...doc.scenes.slice(1)] }, null);
    expect(built.timeline.captions[0].text).toBe("Sáng nay, TP.HCM");
    expect(built.timeline.captions[0].startMs).toBe(chunks[0].startMs + LEAD_MS);
  });
});

describe("docFromTimeline", () => {
  it("prefers the stored document", () => {
    const { timeline } = buildFromDoc(doc, null);
    expect(docFromTimeline(timeline, { doc })).toEqual(doc);
  });
  it("reconstructs a pre-phase-4 timeline: voice keys from the mix key, words from captions", () => {
    const { timeline } = buildFromDoc(doc, { mixKey: "media/o/p/mix/b1.wav", voiceKey: "media/o/p/mix/b1-vo.wav" });
    // Strip what phase 3 did not store.
    const legacy = { ...timeline, scenes: timeline.scenes.map((s) => ({ ...s, voiceSrc: null })), coverAtSec: null };
    const back = docFromTimeline(legacy, { buildId: "b1", voice: { scenes: [{ sceneId: "s1", durationMs: 3000, words: 7 }, { sceneId: "s2", durationMs: 2500, words: 8 }, { sceneId: "s3", durationMs: 1500, words: 4 }] }, music: { source: "mubert", title: "Mubert abc", licence: "Mubert" } });
    expect(back.scenes.map((s) => s.voice?.key)).toEqual(["media/o/p/vo/b1-s1.wav", "media/o/p/vo/b1-s2.wav", "media/o/p/vo/b1-s3.wav"]);
    expect(back.scenes[1].voice?.words.map((w) => w.w).join(" ")).toBe("Tuyến mới dài mười hai ki lô mét.");
    expect(back.scenes[1].voice?.words[0].s).toBe(0);
    expect(back.scenes[0].visual).toMatchObject({ kind: "video", key: "media/o/p/broll/b1-s1.mp4", clipDurationSec: 8 });
    expect(back.music).toMatchObject({ key: "media/o/p/music/b1.mp3", source: "mubert", title: "Mubert abc" });
    // Rebuilding the reconstructed doc reproduces the original layout.
    const again = buildFromDoc(back, null);
    expect(again.timeline.scenes.map((s) => [s.from, s.durationFrames])).toEqual(timeline.scenes.map((s) => [s.from, s.durationFrames]));
    expect(audioSignature(back)).toBe(audioSignature(doc));
  });
});

describe("describeChanges + docKeys", () => {
  it("names each kind of edit", () => {
    const next: EditorDoc = {
      ...moveScene(doc, 0, 1),
      music: null,
      coverAtSec: 3.2,
    };
    next.scenes = next.scenes.map((s) => (s.id === "s2" ? { ...s, onScreenText: "Khác", visual: { kind: "solid" } } : s.id === "s1" ? { ...s, holdMs: 400 } : s));
    const c = describeChanges(doc, next);
    expect(c).toContain("Đổi thứ tự cảnh");
    expect(c).toContain("s2: sửa chữ trên màn hình");
    expect(c).toContain("s2: đổi sang nền màu");
    expect(c).toContain("s1: giữ thêm 400 ms");
    expect(c).toContain("Bỏ nhạc nền");
    expect(c).toContain("Ảnh bìa tại 3.2 s");
    expect(describeChanges(doc, doc)).toEqual([]);
    expect(describeChanges(doc, { ...doc, scenes: doc.scenes.slice(0, 2) })).toContain("Bỏ cảnh s3");
  });
  it("carries the per-scene overlay switch into the timeline and names overlay / kit changes", () => {
    const branded: EditorDoc = { ...doc, brand: { ...doc.brand, name: "Thể thao", overlaySrc: "library/brand/o/overlay-k1.png", overlayLayer: "top" } };
    const next: EditorDoc = { ...branded, scenes: branded.scenes.map((s) => (s.id === "s3" ? { ...s, overlay: false } : s)) };
    const { timeline } = buildFromDoc(next, null);
    expect(timeline.scenes.map((s) => s.overlay)).toEqual([true, true, false]);
    expect(timeline.brand.overlaySrc).toBe("library/brand/o/overlay-k1.png");
    expect(docKeys(next)).toContain("library/brand/o/overlay-k1.png");
    expect(describeChanges(branded, next)).toEqual(["Tắt lớp phủ: s3"]);
    expect(describeChanges(doc, branded)).toEqual(["Đổi bộ nhận diện: Thể thao"]);
    // A kit stored before headline settings existed gets the defaults (automatic position, 54 px).
    expect(doc.brand.headline).toEqual({ fontSize: 54, x: null, y: null });
    expect(doc.brand.caption).toMatchObject({ x: null, y: null });
    // Documents and timelines saved before the overlay existed default to "on" / no overlay.
    expect(doc.scenes.every((s) => s.overlay)).toBe(true);
    expect(buildFromDoc(doc, null).timeline.brand.overlaySrc).toBeNull();
  });
  it("lists every key once", () => {
    expect(docKeys(doc).sort()).toEqual(["media/o/p/aroll/b1-0.jpg", "media/o/p/broll/b1-s1.mp4", "media/o/p/music/b1.mp3", "media/o/p/vo/b1-s1.wav", "media/o/p/vo/b1-s2.wav", "media/o/p/vo/b1-s3.wav"]);
  });

describe("replaceTailShots", () => {
  const img = (key: string): EditorVisual => ({ kind: "image", key, kenBurns: true, focus: null, credit: null, assetId: null, thumbnailUrl: null });
  const clip = (n: number): EditorVisual => ({ kind: "video", key: "cap.mp4", clipDurationSec: 5, trimStartSec: n * 5, credit: "Video: x / YouTube", assetId: "a", thumbnailUrl: null });
  const scene = { ...doc.scenes[0], visual: img("article.jpg"), shots: [img("stock1.jpg"), img("ai1.png")] };

  it("displaces the lowest-priority shots at the tail and keeps the count", () => {
    const next = replaceTailShots(scene, [clip(0), clip(1)]);
    expect([next.visual, ...next.shots].map((v) => (v.kind === "video" ? `clip@${v.trimStartSec}` : v.kind === "image" ? v.key : "solid"))).toEqual(["article.jpg", "clip@0", "clip@5"]);
  });

  it("never grows the scene when more segments arrive than it has shots", () => {
    const next = replaceTailShots(scene, [clip(0), clip(1), clip(2), clip(3)]);
    expect(1 + next.shots.length).toBe(3);
    expect(next.visual).toEqual(clip(0));
  });
});
});
