import { describe, expect, it } from "vitest";
import { checkHyperframesHtml, formatMotionNumber, hyperframesDocument, normaliseMotionSpec, sanitiseHyperframesHtml, type MotionSpec } from "@ai-news/video/motion";
import { brandSchema, motionArea, OUTPUT, SAFE_ZONES } from "@ai-news/video/schema";
import { backdropCandidates, backdropOf, buildFromDoc, docFromTimeline, docKeys, editorDocSchema, shotsMissing, visualKey, type EditorScene } from "./editor";
import { autoMotionCap, motionScenes, shotWords, timingLine } from "./motion-plan";

const scenes = [
  { id: "s1", kind: "hook" as const, voiceover: "Giá vàng tăng 12% trong một tuần" },
  { id: "s2", kind: "body" as const, voiceover: "Người dân xếp hàng từ sáng sớm" },
  { id: "s3", kind: "body" as const, voiceover: "Năm 2025, giá đã lập đỉnh" },
  { id: "s4", kind: "body" as const, voiceover: "Chuyên gia khuyên thận trọng" },
  { id: "s5", kind: "cta" as const, voiceover: "Theo dõi để cập nhật 24/7" },
];

describe("motionScenes", () => {
  it("is empty when off and every scene when all", () => {
    expect(motionScenes("off", scenes, ["s1"])).toEqual([]);
    expect(motionScenes("all", scenes, null)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("keeps Claude's picks in script order, drops unknown ids and caps at half the scenes", () => {
    expect(autoMotionCap(5)).toBe(3);
    expect(motionScenes("auto", scenes, ["s4", "s1", "x9"])).toEqual(["s1", "s4"]);
    expect(motionScenes("auto", scenes, ["s5", "s4", "s3", "s2", "s1"])).toEqual(["s1", "s2", "s3"]);
  });

  it("falls back to scenes stating a figure, never the closing scene", () => {
    expect(motionScenes("auto", scenes, null)).toEqual(["s1", "s3"]);
  });
});

describe("shotWords", () => {
  const words = [
    { w: "Giá", s: 0, e: 300 },
    { w: "vàng", s: 300, e: 600 },
    { w: "tăng", s: 4000, e: 4400 },
    { w: "mạnh", s: 6500, e: 7000 },
  ];
  it("times words from the shot's first frame and drops the ones outside it", () => {
    expect(shotWords(words, 0.25, 5)).toEqual([
      { w: "Giá", at: 0.25 },
      { w: "vàng", at: 0.55 },
      { w: "tăng", at: 4.25 },
    ]);
    // Second shot of the scene, starting 3.75 s after the voice.
    expect(shotWords(words, -3.75, 5)).toEqual([
      { w: "tăng", at: 0.25 },
      { w: "mạnh", at: 2.75 },
    ]);
    expect(timingLine(shotWords(words, 0, 1))).toBe("[0.00] Giá [0.30] vàng");
  });
});

const spec = (beats: MotionSpec["beats"]): MotionSpec => ({ mood: "brand", background: "gradient", backgroundImage: null, beats });
const el = { type: "title" as const, delay: 0, enter: "rise" as const, text: "A", label: null, value: null, prefix: null, suffix: null, decimals: null, items: null, emoji: null, image: null, emphasis: null };

describe("normaliseMotionSpec", () => {
  it("sorts beats, starts the first at 0, drops empty beats and clamps times into the shot", () => {
    const out = normaliseMotionSpec(spec([{ at: 9, align: "center", elements: [el] }, { at: 0.6, align: "top", elements: [el] }, { at: 2, align: "center", elements: [] }]), 5);
    expect(out.beats.map((b) => b.at)).toEqual([0, 4.6]);
    expect(out.beats[0].align).toBe("top");
  });

  it("keeps exactly two sides of a comparison and sane decimals", () => {
    const items = [1, 2, 3].map((v) => ({ label: `x${v}`, value: v, detail: null }));
    const out = normaliseMotionSpec(spec([{ at: 0, align: "center", elements: [{ ...el, type: "compare", items, decimals: 7.4 }] }]), 4);
    expect(out.beats[0].elements[0].items).toHaveLength(2);
    expect(out.beats[0].elements[0].decimals).toBe(3);
  });
});

describe("formatMotionNumber", () => {
  it("groups thousands and writes decimals the way each language does", () => {
    expect(formatMotionNumber(40500, 0, "vi")).toBe("40.500");
    expect(formatMotionNumber(3.456, 1, "vi")).toBe("3,5");
    expect(formatMotionNumber(1234567.5, 1, "en")).toBe("1,234,567.5");
    expect(formatMotionNumber(-12, 0, "en")).toBe("−12");
  });
});

describe("HyperFrames composition", () => {
  const good = `<div data-composition-id="shot" data-start="0" data-duration="5"><h1 id="t">Hi</h1><script>var tl=gsap.timeline({paused:true});window.__timelines={shot:tl};</script></div>`;

  it("accepts a seekable composition and names what is wrong with others", () => {
    expect(checkHyperframesHtml(good)).toEqual([]);
    expect(checkHyperframesHtml("<div>no timeline</div>")).toHaveLength(2);
    expect(checkHyperframesHtml(good.replace("gsap.timeline", "Math.random();gsap.timeline"))).toEqual(["uses wall-clock or random APIs (not seekable)"]);
  });

  it("strips external scripts, frames, links and meta tags", () => {
    const html = `<script src="https://evil.example/x.js"></script><iframe src="https://x"></iframe><link rel="stylesheet" href="https://x"><meta http-equiv="refresh" content="0"><p>ok</p>`;
    expect(sanitiseHyperframesHtml(html)).toBe("<p>ok</p>");
  });

  it("builds a locked-down page with the brand, the pictures and the seek bridge", () => {
    const doc = hyperframesDocument({ html: good.replace("Hi", '<img src="{{image:0}}">'), images: ['https://r2.example/a.jpg?x=1&y="2"'], colours: { primary: "#111", accent: "#f59e0b", background: "#000", text: "#fff", highlight: "#fbbf24" }, fontFamily: "'Inter'", safeBottom: 1300 });
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("--brand-accent:#f59e0b");
    expect(doc).toContain("--safe-bottom:1300px");
    expect(doc).toContain('src="https://r2.example/a.jpg?x=1&amp;y=&quot;2&quot;"');
    expect(doc).toContain("hf-seeked");
    expect(doc).toContain("gsap@3.13.0");
    expect(doc).toContain("background:var(--brand-bg)");
  });

  it("leaves the page transparent when a backdrop clip plays under it", () => {
    const doc = hyperframesDocument({ html: good, images: [], colours: { primary: "#111", accent: "#f59e0b", background: "#000", text: "#fff", highlight: "#fbbf24" }, fontFamily: "'Inter'", safeBottom: 1300, transparent: true });
    expect(doc).toContain("background:transparent");
    expect(doc).not.toContain("background:var(--brand-bg)");
  });
});

describe("motionArea", () => {
  const brand = brandSchema.parse({ colours: {}, fonts: {}, caption: {} });
  it("stays inside the safe zones and above the captions (and the outro on the closing scene)", () => {
    const body = motionArea(brand, "body");
    const cta = motionArea(brand, "cta");
    expect(body.y0).toBeGreaterThanOrEqual(SAFE_ZONES.top);
    expect(body.y1).toBeLessThan(OUTPUT.height - SAFE_ZONES.bottom);
    expect(cta.y1).toBeLessThan(body.y1);
    expect(body.x0).toBeGreaterThanOrEqual(SAFE_ZONES.left);
  });
  it("uses the room below captions that sit in the upper half", () => {
    const top = motionArea(brandSchema.parse({ colours: {}, fonts: {}, caption: { y: 700 } }), "body");
    expect(top.y0).toBeGreaterThan(700);
  });
});

describe("motion shots in the editor document", () => {
  const motionScene: EditorScene = {
    id: "s1",
    kind: "body",
    onScreenText: "Giá vàng",
    voiceover: "Giá vàng tăng 12% trong một tuần qua",
    brollTerms: [],
    newsTerms: [],
    durationSec: 12,
    voice: { key: "media/o/p/vo/b-s1.wav", durationMs: 12000, words: [] },
    visual: { kind: "motion", spec: spec([{ at: 0, align: "center", elements: [el] }]), images: ["media/o/p/aroll/b-0.jpg"], backdrop: null, instruction: null },
    shots: [],
    holdMs: 0,
    overlay: true,
    captions: null,
    cartoon: null,
  };
  const doc = editorDocSchema.parse({ v: 1, title: "t", language: "vi", source: { name: null, url: "" }, brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {} }), scenes: [motionScene], music: null, coverAtSec: null });

  it("needs no extra shots for the 5 s cadence and lists the pictures it uses", () => {
    expect(shotsMissing(doc.scenes[0])).toBe(0);
    expect(visualKey(doc.scenes[0].visual)).toBeNull();
    expect(docKeys(doc)).toContain("media/o/p/aroll/b-0.jpg");
  });

  it("builds a timeline shot carrying the spec, without credit or src", () => {
    const { timeline } = buildFromDoc(doc, null);
    const shot = timeline.scenes[0].shots[0];
    expect(shot.visual.kind).toBe("motion");
    expect(shot.credit).toBeNull();
    expect(shot.durationFrames).toBe(timeline.scenes[0].durationFrames);
  });

  const clip = { kind: "video" as const, key: "media/o/p/broll/b-s1-pexels-1.mp4", clipDurationSec: 8, trimStartSec: 0, credit: "Video: Ann / Pexels", assetId: null, thumbnailUrl: null };
  const backdrop = backdropOf(clip);
  const overVideo = editorDocSchema.parse({ ...doc, scenes: [{ ...motionScene, visual: { ...motionScene.visual, spec: { ...spec([{ at: 0, align: "center", elements: [el] }]), background: "video" }, backdrop } }] });

  it("offers the scene's clips and current backdrops once each as backdrops", () => {
    expect(backdropCandidates({ visual: clip, shots: [{ ...clip, trimStartSec: 5 }, clip, { kind: "solid" }] })).toHaveLength(2);
    expect(backdropCandidates(overVideo.scenes[0])).toEqual([backdrop]);
    expect(backdropCandidates(doc.scenes[0])).toEqual([]);
  });

  it("plays the backdrop clip, lists its key and credits it on the graphic's shot", () => {
    expect(docKeys(overVideo)).toContain(clip.key);
    const { timeline } = buildFromDoc(overVideo, null);
    const shot = timeline.scenes[0].shots[0];
    expect(shot.credit).toBe("Video: Ann / Pexels");
    expect(shot.visual.kind === "motion" && shot.visual.backdrop).toEqual({ src: clip.key, trimStartSec: 0, clipDurationSec: 8 });
  });

  it("keeps the backdrop when a document is rebuilt from its timeline", () => {
    const { timeline } = buildFromDoc(overVideo, null);
    const back = docFromTimeline(timeline, {});
    const v = back.scenes[0].visual;
    expect(v.kind === "motion" && v.backdrop).toMatchObject({ key: clip.key, clipDurationSec: 8, credit: "Video: Ann / Pexels" });
  });
});
