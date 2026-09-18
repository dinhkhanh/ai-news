import { describe, expect, it } from "vitest";
import { landscapeLayout } from "@ai-news/video/schema";
import { frameStill, overlayZones, significantFaces, storedFrame, TARGET, TOLERANCE, type FaceBox, type FrameFaces } from "./framing";

const face = (x: number, y: number, w: number, h: number, confidence = 0.95): FaceBox => ({ x, y, w, h, confidence });
const landscape = (faces: FaceBox[]): FrameFaces => ({ width: 1200, height: 800, faces });
const portrait = (faces: FaceBox[]): FrameFaces => ({ width: 1080, height: 1920, faces });
// Cover-fitted like a landscape picture used to be (only sideways travel), but not landscape: those are no longer cropped.
const square = (faces: FaceBox[]): FrameFaces => ({ width: 1000, height: 1000, faces });
const body = (headline = "Giá xăng tăng mạnh") => overlayZones({ kind: "body", headline, caption: { position: "bottom", fontSize: 64 }, hasCaptions: true, showSource: true, hasLogo: false });

/** Where the faces' box ends up in the 1080×1920 frame for a focus (same maths as News.tsx). */
function placed(frame: FrameFaces, f: FaceBox, focus: { x: number; y: number; zoom: number }) {
  const s = Math.max(1080 / frame.width, 1920 / frame.height) * focus.zoom;
  const left = -focus.x * (frame.width * s - 1080);
  const top = -focus.y * (frame.height * s - 1920);
  return { x0: left + f.x * frame.width * s, y0: top + f.y * frame.height * s, x1: left + (f.x + f.w) * frame.width * s, y1: top + (f.y + f.h) * frame.height * s };
}

describe("overlayZones", () => {
  it("mirrors the News layout: headline in the lower third right above the captions, captions above the bottom safe zone", () => {
    const z = Object.fromEntries(body().map((r) => [r.name, r]));
    expect(z.headline.y1).toBeCloseTo(z.captions.y0 - 24, 5);
    expect(z.headline.y1 - z.headline.y0).toBeLessThan(160); // one line
    expect(z.headline.y0).toBeGreaterThan(1920 * 0.55); // the upper half stays free for faces
    expect(z.captions.y1).toBe(1470);
    expect(z.captions.y0).toBeGreaterThan(1920 * 0.6);
    expect(z.platform_bottom.y0).toBe(1500);
    expect(z.outro).toBeUndefined();
  });

  it("grows the headline upwards with its text, bigger on the hook, and keeps it off the outro and off middle captions", () => {
    const long = "Chính phủ công bố gói hỗ trợ mới cho doanh nghiệp nhỏ và vừa trên cả nước";
    const b = body(long).find((r) => r.name === "headline")!;
    const h = overlayZones({ kind: "hook", headline: long, caption: { position: "bottom", fontSize: 64 }, hasCaptions: true, showSource: false, hasLogo: false }).find((r) => r.name === "headline")!;
    const short = body().find((r) => r.name === "headline")!;
    expect(b.y1).toBe(short.y1);
    expect(b.y0).toBeLessThan(short.y0);
    expect(h.y0).toBeLessThan(b.y0);
    const cta = Object.fromEntries(overlayZones({ kind: "cta", headline: long, caption: { position: "bottom", fontSize: 64 }, hasCaptions: true, showSource: false, hasLogo: false }).map((r) => [r.name, r]));
    expect(cta.headline.y1).toBeLessThanOrEqual(cta.outro.y0 - 24);
    expect(cta.outro.y1).toBeLessThanOrEqual(cta.captions.y0 - 24); // the outro never sits under the captions
    // Captions mid-frame: the headline takes the slot bottom captions would have had, below them.
    const mid = Object.fromEntries(overlayZones({ kind: "body", headline: long, caption: { position: "middle", fontSize: 64 }, hasCaptions: true, showSource: false, hasLogo: false }).map((r) => [r.name, r]));
    expect(mid.headline.y0).toBeGreaterThan(mid.captions.y1);
    expect(mid.headline.y1).toBe(1920 - 450);
  });

  it("follows a kit's manual text position and sizes, and moves the automatic headline with manual captions", () => {
    const zones = (caption: object, headlineStyle?: object, kind: "hook" | "body" = "body") =>
      Object.fromEntries(overlayZones({ kind, headline: "Giá xăng tăng mạnh", caption: { position: "bottom", fontSize: 64, ...caption }, headlineStyle, hasCaptions: true, showSource: false, hasLogo: false }).map((r) => [r.name, r]));
    // Captions lifted to y = 1200: bottom edge exactly there, and the automatic headline still sits 24 px above them.
    const lifted = zones({ y: 1200 });
    expect(lifted.captions.y1).toBe(1200);
    expect(lifted.headline.y1).toBeCloseTo(lifted.captions.y0 - 24, 5);
    // Captions moved into the upper half: the headline takes the bottom-caption slot instead of climbing over faces.
    expect(zones({ y: 500 }).headline.y1).toBe(1470);
    // Manual headline: left edge and bottom edge in px; a bigger font makes a taller card that grows upwards.
    const manual = zones({}, { fontSize: 54, x: 120, y: 400 });
    expect(manual.headline).toMatchObject({ x0: 120, y1: 400 });
    const bigger = zones({}, { fontSize: 90, x: 120, y: 400 });
    expect(bigger.headline.y1).toBe(400);
    expect(bigger.headline.y0).toBeLessThan(manual.headline.y0);
    // Caption centre: the block stays centred on x and narrows near an edge instead of leaving the frame.
    const right = zones({ x: 900 });
    expect((right.captions.x0 + right.captions.x1) / 2).toBe(900);
    expect(right.captions.x1).toBeLessThanOrEqual(1080);
    // Left-aligned captions: x is the left edge (60 by default) and the block runs to the right rail.
    expect(zones({ align: "left" }).captions).toMatchObject({ x0: 60, x1: 900 });
    expect(zones({ align: "left", x: 200 }).captions).toMatchObject({ x0: 200, x1: 900 });
    // The hook keeps its size advantage over the kit's headline size.
    expect(zones({}, { fontSize: 40 }, "hook").headline.y0).toBeLessThan(zones({}, { fontSize: 40 }).headline.y0);
  });

  it("has no headline or caption zone without text, and puts middle captions mid-frame", () => {
    const none = overlayZones({ kind: "body", headline: " ", caption: { position: "bottom", fontSize: 64 }, hasCaptions: false, showSource: false, hasLogo: false });
    expect(none.map((r) => r.name)).toEqual(["platform_bottom", "platform_right"]);
    const mid = overlayZones({ kind: "cta", headline: "", caption: { position: "middle", fontSize: 64 }, hasCaptions: true, showSource: false, hasLogo: true });
    expect(mid.find((r) => r.name === "captions")!.y0).toBe(900);
    expect(mid.map((r) => r.name)).toContain("outro");
    expect(mid.map((r) => r.name)).toContain("logo");
  });
});

describe("significantFaces", () => {
  it("drops low-confidence and background faces, and whole crowds", () => {
    expect(significantFaces(landscape([face(0.4, 0.2, 0.2, 0.3), face(0.8, 0.3, 0.04, 0.06), face(0.1, 0.2, 0.2, 0.3, 0.2)]))).toHaveLength(1);
    expect(significantFaces(landscape([face(0.1, 0.4, 0.02, 0.03), face(0.5, 0.4, 0.02, 0.03)]))).toHaveLength(0);
  });
});

describe("frameStill", () => {
  it("leaves pictures without faces (or never analysed) centred", () => {
    expect(frameStill(null, body())).toMatchObject({ ok: true, focus: null, faces: 0, kenBurns: true });
    expect(frameStill(square([]), body())).toMatchObject({ ok: true, focus: null });
  });

  it("pans a square picture so an off-centre face is centred instead of cropped", () => {
    // Face at the right edge: a centred 9:16 crop (the middle 37.5 %) would cut it off entirely.
    const f = face(0.78, 0.25, 0.1, 0.18);
    const frame = square([f]);
    const r = frameStill(frame, body());
    expect(r.ok).toBe(true);
    const b = placed(frame, f, r.focus!);
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.x1).toBeLessThanOrEqual(1080);
    expect(Math.abs((b.x0 + b.x1) / 2 - TARGET.x)).toBeLessThanOrEqual(TOLERANCE.x);
    expect(Math.abs((b.y0 + b.y1) / 2 - TARGET.y)).toBeLessThanOrEqual(TOLERANCE.y);
    expect(r.focus!.originX).toBeCloseTo((b.x0 + b.x1) / 2 / 1080, 2);
  });

  it("zooms in only as much as needed to lift a low face to the upper-third line", () => {
    const high = frameStill(square([face(0.45, 0.24, 0.1, 0.18)]), body());
    expect(high.focus!.zoom).toBe(1);
    const f = face(0.45, 0.42, 0.1, 0.16);
    const frame = square([f]);
    const low = frameStill(frame, body());
    expect(low.ok).toBe(true);
    expect(low.focus!.zoom).toBeGreaterThan(1);
    expect(low.focus!.zoom).toBeLessThanOrEqual(1.3);
    const b = placed(frame, f, low.focus!);
    expect((b.y0 + b.y1) / 2).toBeLessThanOrEqual(TARGET.y + TOLERANCE.y);
    // A face in the lower part of a square picture is out of reach even at the largest zoom.
    const out = frameStill(square([face(0.45, 0.55, 0.1, 0.16)]), body());
    expect(out.ok).toBe(false);
    expect(out.issues).toContain("face_off_centre");
  });

  it("keeps faces clear of the headline and the captions", () => {
    const zones = body("Chính phủ công bố gói hỗ trợ mới cho doanh nghiệp nhỏ và vừa trên cả nước");
    const headline = zones.find((z) => z.name === "headline")!;
    const captions = zones.find((z) => z.name === "captions")!;
    const f = face(0.4, 0.3, 0.1, 0.14);
    const frame = square([f]);
    const r = frameStill(frame, zones);
    expect(r.ok).toBe(true);
    const b = placed(frame, f, r.focus!);
    expect(b.y1).toBeLessThanOrEqual(headline.y0);
    expect(headline.y1).toBeLessThanOrEqual(captions.y0);
    // A big face right below the top edge used to sit under the headline; the lower-third headline leaves it alone.
    expect(frameStill(square([face(0.4, 0.2, 0.14, 0.22)]), zones).ok).toBe(true);
    // A face low in a portrait picture cannot be lifted out from under the headline.
    expect(frameStill(portrait([face(0.3, 0.52, 0.3, 0.12)]), zones)).toMatchObject({ ok: false, issues: expect.arrayContaining(["face_under_text"]) });
  });

  it("fails a picture whose faces are wider apart than the vertical frame", () => {
    const r = frameStill(square([face(0.08, 0.25, 0.12, 0.2), face(0.8, 0.25, 0.12, 0.2)]), body());
    expect(r.ok).toBe(false);
    expect(r.issues).toContain("face_cropped");
    expect(r.focus).not.toBeNull(); // best effort for a last-resort use
  });

  it("fails a face that cannot leave the caption area", () => {
    const r = frameStill(portrait([face(0.35, 0.7, 0.3, 0.17)]), body());
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining(["face_under_text", "face_off_centre"]));
  });

  it("turns Ken Burns off when only the slow zoom would push a big face into the overlays", () => {
    const zones = body();
    const headline = zones.find((z) => z.name === "headline")!;
    // Everything above the headline is clear now.
    const band = headline.y0;
    // With head-room the face fills ~88 % of the clear band: fits at rest (× 1.06 punch-in), not at × 1.25.
    const h = (band * 0.88) / 1.24 / 1920;
    const f = face(0.3, band / 2 / 1920 - h / 2, 0.4, h);
    const r = frameStill(portrait([f]), zones);
    expect(r.ok).toBe(true);
    expect(r.kenBurns).toBe(false);
  });
});

describe("storedFrame", () => {
  it("reads assets.meta.frame and ignores anything else", () => {
    expect(storedFrame({ frame: { width: 10, height: 20, faces: [] } })).toEqual({ width: 10, height: 20, faces: [] });
    expect(storedFrame({ frame: { width: "10" } })).toBeNull();
    expect(storedFrame({})).toBeNull();
    expect(storedFrame(null)).toBeNull();
  });
});

describe("landscape stills (full width on a blurred backdrop, never cropped)", () => {
  it("sit on the upper-third line, pushed down only by the platform's top bar", () => {
    const wide = landscapeLayout(1600, 900);
    expect(wide.height).toBeCloseTo(607.5, 1);
    expect(wide.top + wide.height / 2).toBeCloseTo(640, 1);
    const tall = landscapeLayout(1000, 990); // nearly square → 1069 px high: centred on 640 it would start at 105, inside the top bar
    expect(tall.top).toBe(120);
  });
  it("pass faces anywhere in the picture without a crop, even at the far left", () => {
    const f = frameStill(landscape([face(0.08, 0.3, 0.12, 0.18)]), body());
    expect(f).toMatchObject({ ok: true, focus: null, kenBurns: true, faces: 1 });
    expect(f.box!.x0).toBeLessThan(80);
  });
  it("still refuse a face that ends up under the headline", () => {
    // 4:3 picture: 810 px high, 235–1045; a face at its very bottom sits under a two-line headline (≈1031–1245).
    const f = frameStill({ width: 1200, height: 900, faces: [face(0.45, 0.9, 0.1, 0.09)] }, body("Chính phủ công bố gói hỗ trợ mới cho doanh nghiệp nhỏ và vừa"));
    expect(f.ok).toBe(false);
    expect(f.issues).toEqual(["face_under_text"]);
  });
});
