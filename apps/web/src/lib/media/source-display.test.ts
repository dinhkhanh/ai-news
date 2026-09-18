import { describe, expect, it } from "vitest";
import { sourceDisplay } from "@ai-news/video/schema";

describe("sourceDisplay", () => {
  it("shows the outlet's name and the URL without scheme or www", () => {
    expect(sourceDisplay({ name: "VnExpress", url: "https://www.vnexpress.net/metro-4712345.html" })).toEqual({ name: "VnExpress", url: "vnexpress.net/metro-4712345.html" });
  });
  it("falls back to the host when the extractor found no name", () => {
    expect(sourceDisplay({ name: null, url: "https://tuoitre.vn/a/b?x=1" })).toEqual({ name: "tuoitre.vn", url: "tuoitre.vn/a/b?x=1" });
    expect(sourceDisplay({ name: "  ", url: "http://example.com/" })).toEqual({ name: "example.com", url: "example.com" });
  });
});
