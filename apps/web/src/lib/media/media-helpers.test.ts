import { describe, expect, it } from "vitest";
import { alignWords, proportionalTimings, readTwice } from "./align";
import { chunkCaptions } from "./captions";
import { applyPronunciations, displayTimedWords, pronounce, splitWords, validPronunciation } from "./pronounce";

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

describe("pronounce / displayTimedWords", () => {
  const dict = [
    { term: "VnExpress", replacement: "Vi En Express" },
    { term: "TP.HCM", replacement: "Thành phố Hồ Chí Minh" },
    { term: "HCM", replacement: "Hồ Chí Minh" },
  ];
  it("reads the replacement but shows the term as written, punctuation kept", () => {
    const r = pronounce("Theo (VnExpress), giá tăng.", dict);
    expect(r.spoken).toBe("Theo (Vi En Express), giá tăng.");
    expect(r.groups).toEqual([{ display: "Theo", n: 1 }, { display: "(VnExpress),", n: 3 }, { display: "giá", n: 1 }, { display: "tăng.", n: 1 }]);
    expect(splitWords(r.spoken).length).toBe(r.groups.reduce((a, g) => a + g.n, 0));
  });
  it("never matches a shorter term inside a replacement", () => {
    const r = pronounce("TP.HCM mưa", dict);
    expect(r.spoken).toBe("Thành phố Hồ Chí Minh mưa");
    expect(r.applied).toEqual(["TP.HCM"]);
    expect(r.groups).toEqual([{ display: "TP.HCM", n: 5 }, { display: "mưa", n: 1 }]);
  });
  it("folds the timed spoken words back into the written term", () => {
    const r = pronounce("Báo VnExpress đưa tin", dict);
    const timed = splitWords(r.spoken).map((w, i) => ({ w, s: i * 100, e: i * 100 + 90 }));
    expect(displayTimedWords(timed, r.groups)).toEqual([
      { w: "Báo", s: 0, e: 90 },
      { w: "VnExpress", s: 100, e: 390 },
      { w: "đưa", s: 400, e: 490 },
      { w: "tin", s: 500, e: 590 },
    ]);
    expect(displayTimedWords(timed.slice(1), r.groups)).toHaveLength(5); // counts differ: left as spoken
  });
});

describe("validPronunciation", () => {
  it("accepts a plain entry and names what is wrong otherwise", () => {
    expect(validPronunciation("VnExpress", "Vi En Express")).toBeNull();
    expect(validPronunciation("TP. HCM", "Thành phố Hồ Chí Minh")).toBeNull();
    expect(validPronunciation("", "x")).not.toBeNull();
    expect(validPronunciation("TP.", "Thành phố")).toBeNull();
    expect(validPronunciation(" GDP", "gi đi pi")).not.toBeNull();
    expect(validPronunciation("GDP", "GDP")).not.toBeNull();
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

describe("readTwice", () => {
  const heard = (t: string) => t.split(" ").map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 300 }));
  it("catches a Gemini take that repeats the whole text or its last sentence", () => {
    // Transcripts of real Gemini-TTS takes ("roi mây" misheard as "jory").
    expect(readTwice(splitWords("Năm học mới vừa bắt đầu. Mẹ đặt mua hai cây roi mây."), heard("năm học mới vừa bắt đầu mẹ đặt mua hai cây roi mây năm học mới vừa bắt đầu mẹ đặt mua hai cây roi mây"))).toBe(true);
    expect(readTwice(splitWords("Đơn hàng là hai cây roi mây. Người ra nhận lại là đứa trẻ."), heard("đơn hàng là hai cây jory người ra nhận là đứa trẻ Người Ra nhận lại là đứa trẻ"))).toBe(true);
  });
  it("accepts a single read, misheard words and repeats the script itself has", () => {
    expect(readTwice(splitWords("Đơn hàng là hai cây roi mây. Người ra nhận lại là đứa trẻ."), heard("đơn hàng là hai cây jory người ra nhận lại là đứa trẻ"))).toBe(false);
    expect(readTwice(splitWords("Không phải sách. Không phải vở. Là roi mây."), heard("không phải sách không phải vở là roi mây"))).toBe(false);
    expect(readTwice(splitWords("Đi đi đi. Đi đi đi."), heard("đi đi đi đi đi đi"))).toBe(false);
    expect(readTwice([], heard("xin chào"))).toBe(false);
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
