import { describe, expect, it } from "vitest";
import { alignWords, proportionalTimings } from "./align";
import { chunkCaptions } from "./captions";
import { applyPronunciations, splitWords } from "./pronounce";

describe("applyPronunciations", () => {
  const dict = [
    { term: "TP.HCM", replacement: "Thành phố Hồ Chí Minh" },
    { term: "TP. HCM", replacement: "Thành phố Hồ Chí Minh" },
    { term: "UBND", replacement: "Ủy ban nhân dân" },
    { term: "GDP", replacement: "GDP" },
  ];
  it("replaces whole tokens only, longest first", () => {
    const r = applyPronunciations("UBND TP. HCM và UBND TP.HCM, (UBND) nhưng không UBNDX.", dict);
    expect(r.text).toBe("Ủy ban nhân dân Thành phố Hồ Chí Minh và Ủy ban nhân dân Thành phố Hồ Chí Minh, (Ủy ban nhân dân) nhưng không UBNDX.");
    expect(r.applied.sort()).toEqual(["TP. HCM", "TP.HCM", "UBND"]);
  });
  it("is case-sensitive and skips identity entries", () => {
    expect(applyPronunciations("gdp GDP", dict).text).toBe("gdp GDP");
  });
  it("splits words on whitespace", () => {
    expect(splitWords("  Sáng nay,  Thành phố ")).toEqual(["Sáng", "nay,", "Thành", "phố"]);
  });
});

describe("alignWords", () => {
  const script = ["Sáng", "nay,", "Ủy", "ban", "nhân", "dân", "công", "bố", "kế", "hoạch."];
  it("takes STT times for matched words and interpolates the rest", () => {
    const stt = [
      { word: "sáng", startMs: 100, endMs: 400 },
      { word: "nay", startMs: 400, endMs: 700 },
      { word: "uỷ", startMs: 800, endMs: 1000 }, // different spelling → unmatched
      { word: "ban", startMs: 1000, endMs: 1200 },
      { word: "nhân", startMs: 1200, endMs: 1400 },
      { word: "dân", startMs: 1400, endMs: 1600 },
      { word: "công", startMs: 1900, endMs: 2100 },
      { word: "bố", startMs: 2100, endMs: 2300 },
      { word: "kế", startMs: 2400, endMs: 2600 },
      { word: "hoạch", startMs: 2600, endMs: 3000 },
    ];
    const r = alignWords(script, stt, 3200, 500);
    expect(r.method).toBe("stt");
    expect(r.matched).toBe(9);
    expect(r.words[0]).toEqual({ w: "Sáng", s: 600, e: 900 });
    expect(r.words[2].s).toBeGreaterThanOrEqual(1200);
    expect(r.words[2].e).toBeLessThanOrEqual(1500);
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].s).toBeGreaterThanOrEqual(r.words[i - 1].e);
    expect(r.words.at(-1)!.e).toBeLessThanOrEqual(3700);
  });
  it("falls back to proportional timings when the transcript does not match", () => {
    const r = alignWords(script, [{ word: "hello", startMs: 0, endMs: 500 }], 3000);
    expect(r.method).toBe("proportional");
    expect(r.words[0].s).toBe(0);
    expect(r.words.at(-1)!.e).toBe(3000);
  });
  it("spreads proportionally by length", () => {
    const t = proportionalTimings(["a", "bbbb"], 1000);
    expect(t[0].e - t[0].s).toBeLessThan(t[1].e - t[1].s);
  });
});

describe("chunkCaptions", () => {
  it("breaks on clause ends and size budgets", () => {
    const words = "Sáng nay, Ủy ban nhân dân Thành phố Hồ Chí Minh công bố kế hoạch mở rộng tuyến metro số một.".split(" ").map((w, i) => ({ w, s: i * 300, e: i * 300 + 280 }));
    const chunks = chunkCaptions(words);
    expect(chunks[0].text).toBe("Sáng nay,");
    for (const c of chunks) {
      expect(c.words.length).toBeLessThanOrEqual(5);
      expect(c.text.length).toBeLessThanOrEqual(30);
      expect(c.endMs).toBeGreaterThan(c.startMs);
    }
    expect(chunks.map((c) => c.text).join(" ")).toBe(words.map((w) => w.w).join(" "));
  });
});
