import { describe, expect, it } from "vitest";
import { balloonEntries, beatCamera, cameraAt, CARTOON_MAX_ZOOM, CARTOON_MOVE_FRAMES, CARTOON_VIEW, cartoonRuns, overviewCamera, stageBounds, stageTransform, type CartoonPanel } from "@ai-news/video/cartoon";

const balloon = (id: string, kind: "speech" | "caption" | "sfx", rect: { x: number; y: number; w: number; h: number }, tail: { x: number; y: number } | null = null) => ({ id, kind, speaker: null, text: id, rect, tail, fontSize: 30, manual: false });

const panel = (w: number, h: number, balloons: CartoonPanel["balloons"] = []): CartoonPanel => ({ page: 1, w, h, src: "k", imgW: w, imgH: h, crop: null, balloons });

describe("cartoon camera", () => {
  it("draws balloons that stick out of the panel inside the stage", () => {
    const st = stageBounds(panel(600, 600, [balloon("a", "speech", { x: -40, y: 500, w: 200, h: 150 }, { x: 100, y: 700 })]));
    expect(st.x).toBeLessThan(-40);
    expect(st.y + st.h).toBeGreaterThan(700);
  });

  it("moves in on the balloon and the speaker, never past the furthest zoom, and holds the view inside the panel", () => {
    const p = panel(1000, 1000, [balloon("a", "speech", { x: 600, y: 50, w: 300, h: 150 }, { x: 750, y: 300 })]);
    const cam = beatCamera(p, { balloon: "a", face: { x: 0.65, y: 0.3, w: 0.2, h: 0.2 } });
    expect(cam.zoom).toBeGreaterThan(1.2);
    expect(cam.zoom).toBeLessThanOrEqual(CARTOON_MAX_ZOOM);
    expect(cam.cx).toBeGreaterThan(500);
    // The right edge of the view stays on the stage.
    const st = stageBounds(p);
    const t = stageTransform(st, cam);
    expect(t.tx + st.w * t.scale).toBeGreaterThanOrEqual(CARTOON_VIEW.x + CARTOON_VIEW.w - 0.5);
    // Narration and silence frame the whole panel.
    expect(beatCamera(p, { balloon: null, face: null })).toEqual({ cx: st.x + st.w / 2, cy: st.y + st.h / 2, zoom: 1 });
  });

  it("reads a wide panel across in the reading direction, keeping its caption in view", () => {
    const p = panel(1200, 400, [balloon("c", "caption", { x: 20, y: 20, w: 300, h: 80 })]);
    const st = stageBounds(p);
    const ltr = overviewCamera(st, 1);
    expect(ltr.zoom).toBeGreaterThan(1.05);
    expect(ltr.panTo!.cx).toBeGreaterThan(ltr.cx);
    const rtl = overviewCamera(st, -1);
    expect(rtl.panTo!.cx).toBeLessThan(rtl.cx);
    const cap = beatCamera(p, { balloon: "c", face: null });
    const half = CARTOON_VIEW.w / (2 * (CARTOON_VIEW.w / st.w) * cap.zoom);
    expect(cap.panTo!.cx - half).toBeLessThanOrEqual(20);
  });

  it("glides from where the previous beat ended", () => {
    const p = panel(1000, 1000, [balloon("a", "speech", { x: 50, y: 50, w: 200, h: 100 }), balloon("b", "speech", { x: 700, y: 700, w: 200, h: 100 })]);
    const st = stageBounds(p);
    const beats = [
      { from: 0, durationFrames: 60, camera: beatCamera(p, { balloon: "a", face: null }) },
      { from: 60, durationFrames: 60, camera: beatCamera(p, { balloon: "b", face: null }) },
    ];
    const open = overviewCamera(st);
    expect(cameraAt(beats, open, 0)).toEqual({ cx: open.cx, cy: open.cy, zoom: open.zoom });
    const end = cameraAt(beats, open, 59.999);
    const start = cameraAt(beats, open, 60);
    expect(start.cx).toBeCloseTo(end.cx, 0);
    expect(cameraAt(beats, open, 60 + CARTOON_MOVE_FRAMES).cx).toBeCloseTo(beats[1].camera.cx, 0);
  });

  it("groups consecutive beats of a panel and pops each balloon when its line starts", () => {
    const runs = cartoonRuns([
      { from: 0, durationFrames: 30, cartoon: { panel: "a", balloon: "x", face: null } },
      { from: 30, durationFrames: 30, cartoon: { panel: "a", balloon: "y", face: null } },
      { from: 60, durationFrames: 30, cartoon: { panel: "b", balloon: null, face: null } },
    ]);
    expect(runs.map((r) => [r.panel, r.from, r.durationFrames, r.scenes.length])).toEqual([
      ["a", 0, 60, 2],
      ["b", 60, 30, 1],
    ]);
    const p = panel(500, 500, [balloon("x", "speech", { x: 0, y: 0, w: 10, h: 10 }), balloon("y", "speech", { x: 0, y: 0, w: 10, h: 10 }), balloon("s", "sfx", { x: 0, y: 0, w: 10, h: 10 })]);
    const e = balloonEntries(p, [{ from: 0, balloon: "x" }, { from: 30, balloon: "y" }]);
    expect(e.x).toBe(2);
    expect(e.y).toBe(32);
    expect(e.s).toBeGreaterThan(0);
  });
});
