import { captionLines } from "@ai-news/video/schema";
import { describe, expect, it } from "vitest";
import { chunkCaptions, endsSentence } from "./captions";
import { compoundJoins, markCompounds } from "./compounds";

const timed = (text: string) => text.split(" ").map((w, i) => ({ w, s: i * 300, e: i * 300 + 280 }));
/** "a b_c d": which words are joined to the next one, as text. */
const joined = (text: string) => {
  const words = text.split(" ");
  const joins = compoundJoins(words);
  return words.map((w, i) => w + (i === words.length - 1 ? "" : joins[i] ? "_" : " ")).join("");
};
const lineTexts = (words: Array<{ w: string; j?: boolean }>) => captionLines(words).lines.map((line) => line.flat().map((i) => words[i].w).join(" "));

const STORY =
  "Sáng nay, Ủy ban nhân dân Thành phố Hồ Chí Minh công bố kế hoạch mở rộng tuyến metro số 1. Dự án có tổng vốn đầu tư hơn 5 tỷ đồng, dự kiến hoàn thành vào năm 2030. Tại Mỹ. Công ty Apple cho biết doanh thu quý 3 tăng 12% so với cùng kỳ. Tuyệt! Người dùng Việt Nam có thể đặt mua iPhone 17 từ tuần sau.";

describe("compoundJoins", () => {
  it("joins dictionary words, names and figures", () => {
    expect(joined("Thành phố công bố kế hoạch")).toBe("Thành_phố công_bố kế_hoạch");
    expect(joined("ông Donald Trump đến Hà Nội hôm nay")).toBe("ông Donald_Trump đến Hà_Nội hôm_nay");
    expect(joined("vốn 5 tỷ đồng vào năm 2030 tăng 12% nhờ iPhone 17")).toBe("vốn 5_tỷ_đồng vào năm_2030 tăng 12% nhờ iPhone_17");
  });
  it("reads both tone placements", () => {
    expect(joined("hoà bình và hòa bình")).toBe("hoà_bình và hòa_bình");
  });
  it("never joins across punctuation", () => {
    expect(joined("ở thành, phố lớn")).toBe("ở thành, phố lớn");
    expect(joined("tại Mỹ. Apple (Mỹ) Trung Quốc")).toBe("tại Mỹ. Apple (Mỹ) Trung_Quốc");
  });
  it("marks words and drops stale marks", () => {
    expect(markCompounds([{ w: "rất", j: true }, { w: "công" }, { w: "ty" }])).toEqual([{ w: "rất" }, { w: "công", j: true }, { w: "ty" }]);
  });
});

describe("endsSentence", () => {
  it("needs final punctuation and no lower-case continuation", () => {
    const w = timed("Và rồi… im lặng. TP. Hồ Chí Minh đây.");
    expect(w.map((_, i) => endsSentence(w, i))).toEqual([false, false, false, true, false, false, false, false, true]);
  });
});

describe("chunkCaptions", () => {
  const chunks = chunkCaptions(timed(STORY));

  it("keeps every word, in order", () => {
    expect(chunks.map((c) => c.text).join(" ")).toBe(STORY);
    for (const c of chunks) expect(c.endMs).toBeGreaterThan(c.startMs);
  });
  it("has no one-word chunk unless the sentence is one word", () => {
    expect(chunks.filter((c) => c.words.length === 1).map((c) => c.text)).toEqual(["Tuyệt!"]);
    expect(chunks.map((c) => c.text)).toContain("Tại Mỹ.");
  });
  it("never mixes two sentences in a chunk", () => {
    for (const c of chunks) expect(c.words.slice(0, -1).some((_, i) => endsSentence(c.words, i))).toBe(false);
  });
  it("never splits a compound between chunks", () => {
    const all = markCompounds(timed(STORY));
    let at = 0;
    for (const c of chunks) {
      at += c.words.length;
      expect(all[at - 1].j ?? false).toBe(false);
      expect(c.words[c.words.length - 1].j ?? false).toBe(false);
    }
  });
  it("stays within the budget, one word over at most", () => {
    for (const c of chunks) {
      expect(c.words.length).toBeLessThanOrEqual(6);
      expect(c.text.length).toBeLessThanOrEqual(30);
    }
  });
  it("prefers clause breaks", () => {
    expect(chunks[0].text).toBe("Sáng nay,");
  });
  it("pulls a word over instead of leaving the last one alone", () => {
    const six = chunkCaptions(timed("một hai ba bốn năm sáu."), { maxWords: 5 });
    expect(six.map((c) => c.words.length).every((n) => n >= 2)).toBe(true);
  });
});

describe("captionLines", () => {
  it("has no lone word on a line and keeps compounds whole, in every chunk", () => {
    for (const c of chunkCaptions(timed(STORY))) {
      const { lines } = captionLines(c.words);
      if (lines.length > 1) for (const line of lines) expect(line.flat().length).toBeGreaterThanOrEqual(2);
      // Units are the joined runs, untouched.
      expect(lines.flat().map((u) => u.length)).toEqual(
        c.words.reduce<number[]>((acc, w, i) => (i > 0 && c.words[i - 1].j ? [...acc.slice(0, -1), acc[acc.length - 1] + 1] : [...acc, 1]), []),
      );
    }
  });
  it("balances the two lines", () => {
    expect(lineTexts(markCompounds(timed("Công ty vừa công bố kết quả")))).toEqual(["Công ty vừa", "công bố kết quả"]);
  });
  it("keeps up to three words on one line", () => {
    expect(lineTexts(timed("một hai ba"))).toEqual(["một hai ba"]);
  });
  it("breaks a hand-edited caption between its sentences", () => {
    const words = timed("Xong. Sau đó anh đi");
    expect(lineTexts(words)).toEqual(["Xong.", "Sau đó anh đi"]);
    expect(captionLines(words).hard).toBe(true);
  });
});
