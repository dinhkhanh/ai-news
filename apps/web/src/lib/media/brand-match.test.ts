import { describe, expect, it } from "vitest";
import { foldText, keywordScore, parseKeywords, pickKitByKeywords, type KitCandidate } from "./brand-match";
import { pngInfo } from "./png";

const kit = (id: string, keywords: string[], isDefault = false): KitCandidate => ({ id, name: id, description: "", keywords, isDefault });

describe("brand kit keyword matching", () => {
  it("folds Vietnamese diacritics and punctuation", () => {
    expect(foldText("Bóng đá: V-League 2026!")).toBe("bong da v league 2026");
  });

  it("parses the keyword field, deduplicating on the folded form", () => {
    expect(parseKeywords("bóng đá, Bong Da; V-League\n a ,  SEA   Games ")).toEqual(["bóng đá", "V-League", "SEA Games"]);
  });

  it("matches whole words only and weighs the title", () => {
    const article = { title: "Đội tuyển bóng đá Việt Nam thắng", text: "Trận bóng đá tối qua. Ban tổ chức cho biết…" };
    expect(keywordScore(kit("sport", ["bóng đá"]), article)).toEqual({ score: 4, hits: ["bóng đá"] });
    // "ban" must not hit inside another word, and a one-letter fold is ignored.
    expect(keywordScore(kit("x", ["an", "ba"]), article).score).toBe(0);
  });

  it("picks the clear winner, and nothing on a tie or a weak score", () => {
    const kits = [kit("news", [], true), kit("sport", ["bóng đá", "V-League"]), kit("tech", ["AI", "chip", "điện thoại"])];
    expect(pickKitByKeywords(kits, { title: "V-League: bóng đá trở lại", text: "bóng đá" })?.id).toBe("sport");
    expect(pickKitByKeywords(kits, { title: "Giá vàng hôm nay", text: "vàng tăng" })).toBeNull();
    expect(pickKitByKeywords(kits, { title: null, text: "bóng đá và chip, bóng đá và chip" })).toBeNull();
  });
});

describe("pngInfo", () => {
  const png = (colourType: number, chunks: Array<[string, number]> = []) => {
    const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...[..."IHDR"].map((c) => c.charCodeAt(0)), 0, 0, 0x04, 0x38, 0, 0, 0x07, 0x80, 8, colourType, 0, 0, 0, 0, 0, 0, 0];
    for (const [t, len] of chunks) bytes.push(0, 0, 0, len, ...[...t].map((c) => c.charCodeAt(0)), ...new Array(len + 4).fill(0));
    return new Uint8Array(bytes);
  };

  it("reads the size and the alpha channel", () => {
    expect(pngInfo(png(6))).toEqual({ width: 1080, height: 1920, hasAlpha: true });
    expect(pngInfo(png(2, [["IDAT", 4]]))).toEqual({ width: 1080, height: 1920, hasAlpha: false });
  });

  it("accepts a palette PNG with a tRNS chunk before the image data", () => {
    expect(pngInfo(png(3, [["PLTE", 6], ["tRNS", 2], ["IDAT", 4]]))?.hasAlpha).toBe(true);
    expect(pngInfo(png(3, [["PLTE", 6], ["IDAT", 4], ["tRNS", 2]]))?.hasAlpha).toBe(false);
  });

  it("rejects other files", () => {
    expect(pngInfo(new Uint8Array(64))).toBeNull();
  });
});
