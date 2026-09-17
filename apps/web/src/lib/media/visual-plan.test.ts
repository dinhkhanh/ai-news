import { describe, expect, it } from "vitest";
import { allocate, allocateChecked, orderByTier, shortfall, splitBudget, TIER_RANK, total, videoSegments, VISUAL_TIERS, youtubeId } from "./visual-plan";

describe("visual sourcing priority", () => {
  it("is article → (related = web video) → stock → AI", () => {
    expect(VISUAL_TIERS).toEqual(["article", "related", "web_video", "stock", "ai"]);
    expect(TIER_RANK.related).toBe(TIER_RANK.web_video);
    expect(TIER_RANK.article).toBeLessThan(TIER_RANK.related);
    expect(TIER_RANK.web_video).toBeLessThan(TIER_RANK.stock);
    expect(TIER_RANK.stock).toBeLessThan(TIER_RANK.ai);
  });

  it("orders a scene's shots by tier, keeping the order within a rank", () => {
    const shots = [
      { tier: "ai" as const, id: "g1" },
      { tier: "stock" as const, id: "s1" },
      { tier: "web_video" as const, id: "w1" },
      { tier: "article" as const, id: "a1" },
      { tier: "related" as const, id: "r1" },
      { tier: "stock" as const, id: "s2" },
      { tier: "article" as const, id: "a2" },
    ];
    expect(orderByTier(shots).map((s) => s.id)).toEqual(["a1", "a2", "w1", "r1", "s1", "s2", "g1"]);
  });
});

describe("shortfall / total", () => {
  it("never goes negative and treats missing scenes as empty", () => {
    expect(shortfall({ s1: 3, s2: 1, cta: 1 }, { s1: 1, s2: 4 })).toEqual({ s1: 2, s2: 0, cta: 1 });
    expect(total({ s1: 2, s2: 0, cta: 1 })).toBe(3);
  });
});

describe("allocate", () => {
  const seg0 = (index: number) => ({ index, segment: 0 });

  it("honours ranked picks first, then fills in pool order, each image once", () => {
    const r = allocate([{ id: "s1", want: 2 }, { id: "s2", want: 2 }], 4, { s1: [3], s2: [3, 0] });
    expect(r.perScene).toEqual({ s1: [seg0(3), seg0(1)], s2: [seg0(0), seg0(2)] });
    expect(r.used).toBe(4);
  });

  it("ignores out-of-range picks and stops when the pool is exhausted", () => {
    const r = allocate([{ id: "s1", want: 3 }, { id: "s2", want: 1 }], 2, { s1: [9, -1, 1.5, 1] });
    expect(r.perScene).toEqual({ s1: [seg0(1), seg0(0)], s2: [] });
    expect(r.used).toBe(2);
  });

  it("lets a multi-segment video fill consecutive shots, never the same segment twice", () => {
    // pool: 0 = article image, 1 = web video with 3 segments, 2 = related image
    const r = allocate([{ id: "s1", want: 3 }, { id: "s2", want: 2 }], 3, { s1: [1], s2: [1, 2] }, [1, 3, 1]);
    expect(r.perScene).toEqual({
      s1: [{ index: 1, segment: 0 }, { index: 1, segment: 1 }, { index: 1, segment: 2 }],
      s2: [seg0(2), seg0(0)],
    });
    expect(r.used).toBe(3);
  });

  it("treats capacity 0 as unusable (e.g. a download that failed)", () => {
    const r = allocate([{ id: "s1", want: 2 }], 2, { s1: [0] }, [0, 1]);
    expect(r.perScene).toEqual({ s1: [seg0(1)] });
  });

  it("gives a scene nothing when it wants nothing", () => {
    expect(allocate([{ id: "s1", want: 0 }], 3, { s1: [0, 1] }).perScene).toEqual({ s1: [] });
  });
});

describe("splitBudget", () => {
  it("hands out a shared budget in scene order", () => {
    expect(splitBudget([{ id: "s1", want: 2 }, { id: "s2", want: 3 }, { id: "s3", want: 1 }], 4)).toEqual({ s1: 2, s2: 2, s3: 0 });
    expect(splitBudget([{ id: "s1", want: 2 }], 0)).toEqual({ s1: 0 });
    expect(splitBudget([{ id: "s1", want: 1 }], Number.POSITIVE_INFINITY)).toEqual({ s1: 1 });
  });
});

describe("videoSegments", () => {
  it("skips a lead-in on longer videos and caps the segments", () => {
    expect(videoSegments(12)).toEqual({ startSec: 0, endSec: 10, capacity: 2 });
    expect(videoSegments(45)).toEqual({ startSec: 3, endSec: 23, capacity: 4 });
    expect(videoSegments(600, 6)).toEqual({ startSec: 8, endSec: 38, capacity: 6 });
  });
  it("marks videos that are too short or unknown as unusable", () => {
    expect(videoSegments(4).capacity).toBe(0);
    expect(videoSegments(null).capacity).toBe(0);
  });
});

describe("youtubeId", () => {
  it("reads the id from every YouTube URL shape and rejects the rest", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=5mIxqMPRwpU&t=3s")).toBe("5mIxqMPRwpU");
    expect(youtubeId("https://youtu.be/5mIxqMPRwpU?si=abc")).toBe("5mIxqMPRwpU");
    expect(youtubeId("https://m.youtube.com/shorts/5mIxqMPRwpU")).toBe("5mIxqMPRwpU");
    expect(youtubeId("https://www.youtube.com/embed/5mIxqMPRwpU")).toBe("5mIxqMPRwpU");
    expect(youtubeId("https://www.tiktok.com/@x/video/7")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeId("not a url")).toBeNull();
  });
});

describe("allocateChecked", () => {
  it("drops a vetoed picture for the whole video and lets the next candidate take the shot", () => {
    const r = allocateChecked([{ id: "s1", want: 1 }, { id: "s2", want: 1 }], 3, { s1: [0], s2: [1] }, [], (index) => index !== 0);
    expect(r.perScene).toEqual({ s1: [{ index: 2, segment: 0 }], s2: [{ index: 1, segment: 0 }] });
    expect(r.rejected).toEqual([{ index: 0, sceneId: "s1" }]);
  });

  it("checks replacements too and leaves the shot open when nothing passes", () => {
    const r = allocateChecked([{ id: "s1", want: 2 }], 3, {}, [], (index) => index === 1);
    expect(r.perScene.s1).toEqual([{ index: 1, segment: 0 }]);
    expect(r.rejected.map((x) => x.index).sort()).toEqual([0, 2]);
  });

  it("equals allocate when everything is accepted, capacities included", () => {
    const wanting = [{ id: "s1", want: 3 }, { id: "s2", want: 1 }];
    expect(allocateChecked(wanting, 2, { s1: [1] }, [1, 2], () => true)).toEqual({ ...allocate(wanting, 2, { s1: [1] }, [1, 2]), rejected: [] });
  });
});
