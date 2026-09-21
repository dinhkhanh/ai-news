import { describe, expect, it } from "vitest";
import { buildMetadata, chunkPlan, composeDescription, idempotencyKey, normaliseHashtags, parseVietnamLocal, postUrl, truncate, validateMetadata } from "./platforms";
import { signState, verifyState } from "./state";

const source = { siteName: "VnExpress", url: "https://vnexpress.net/bai-1.html" };

describe("buildMetadata", () => {
  it("forces #Shorts first on YouTube and keeps the source line", () => {
    const m = buildMetadata({ platform: "youtube", meta: { title: "Tin nóng", description: "Mô tả", hashtags: ["#tin", "tin", "kinhte"] }, fallbackTitle: "x", language: "vi", source, aiDisclosure: true });
    expect(m.hashtags).toEqual(["Shorts", "tin", "kinhte"]);
    expect(m.title).toBe("Tin nóng");
    expect(m.description).toContain("Nguồn: VnExpress · https://vnexpress.net/bai-1.html");
    // YouTube has a machine flag, so no disclosure line in the text.
    expect(m.description).not.toContain("AI");
  });
  it("adds the disclosure line where the platform has no flag", () => {
    const m = buildMetadata({ platform: "facebook", meta: { title: "T", description: "D", hashtags: [] }, fallbackTitle: "x", language: "en", source, aiDisclosure: true });
    expect(m.description).toContain("This video was produced with AI tools.");
  });
  it("respects title limits and falls back to the project title", () => {
    const m = buildMetadata({ platform: "youtube", meta: { title: "a".repeat(140), description: "", hashtags: [] }, fallbackTitle: "fallback", language: "vi", source, aiDisclosure: false });
    expect(m.title.length).toBeLessThanOrEqual(100);
    const f = buildMetadata({ platform: "youtube", meta: null, fallbackTitle: "fallback", language: "vi", source, aiDisclosure: false });
    expect(f.title).toBe("fallback");
  });
  it("leaves the source line out for content typed in without a link", () => {
    const m = buildMetadata({ platform: "facebook", meta: { title: "T", description: "D", hashtags: [] }, fallbackTitle: "x", language: "vi", source: { siteName: null, url: null }, aiDisclosure: false });
    expect(m.description).toBe("D");
    const v = buildMetadata({ platform: "facebook", meta: { title: "T", description: "D", hashtags: [] }, fallbackTitle: "x", language: "vi", source: { siteName: "TikTok", url: "https://www.tiktok.com/@x/video/1" }, aiDisclosure: false });
    expect(v.description).toBe("D\n\nNguồn: TikTok · https://www.tiktok.com/@x/video/1");
  });
  it("puts caption and hashtags in the TikTok title within 2200 chars", () => {
    const m = buildMetadata({ platform: "tiktok", meta: { title: "T", description: "d".repeat(3000), hashtags: ["a", "b"] }, fallbackTitle: "x", language: "vi", source, aiDisclosure: true });
    expect(m.title.length).toBeLessThanOrEqual(2200);
    expect(m.title.endsWith("#a #b")).toBe(true);
    expect(m.description).toBe("");
  });
});

describe("composeDescription / validateMetadata", () => {
  it("appends hashtags and stays within the limit", () => {
    const d = composeDescription("instagram", "x".repeat(2300), ["a", "b"]);
    expect(d.length).toBeLessThanOrEqual(2200);
    expect(d.endsWith("#a #b")).toBe(true);
  });
  it("flags limits, privacy and duration", () => {
    expect(validateMetadata("youtube", { title: "", description: "", hashtags: [] }, "public", 60)).toContain("Thiếu tiêu đề");
    expect(validateMetadata("facebook", { title: "t", description: "", hashtags: [] }, "public", 120)[0]).toMatch(/90 giây/);
    expect(validateMetadata("tiktok", { title: "t", description: "", hashtags: [] }, "public", 30)[0]).toMatch(/hiển thị/);
    expect(validateMetadata("youtube", { title: "t", description: "", hashtags: [] }, "unlisted", 30)).toEqual([]);
  });
});

describe("helpers", () => {
  it("truncates on a word boundary", () => {
    expect(truncate("hello brave new world", 12)).toBe("hello brave…");
    expect(truncate("short", 12)).toBe("short");
  });
  it("normalises hashtags", () => {
    expect(normaliseHashtags(["#Việt Nam", "vietnam", "#VietNam"], "facebook")).toEqual(["ViệtNam", "vietnam"]);
  });
  it("keys one attempt", () => {
    expect(idempotencyKey("r", "c", 2)).toBe("pub:r:c:2");
  });
  it("plans TikTok chunks", () => {
    expect(chunkPlan(3 * 1024 * 1024)).toEqual({ chunkSize: 3 * 1024 * 1024, count: 1, ranges: [{ start: 0, end: 3 * 1024 * 1024 - 1 }] });
    const p = chunkPlan(50_000_123, 10_000_000);
    expect(p.count).toBe(5);
    expect(p.ranges[4]).toEqual({ start: 40_000_000, end: 50_000_122 });
    expect(p.ranges[0]).toEqual({ start: 0, end: 9_999_999 });
  });
  it("builds post URLs", () => {
    expect(postUrl("youtube", "abc")).toBe("https://www.youtube.com/shorts/abc");
    expect(postUrl("tiktok", "1", { handle: "suzu" })).toBe("https://www.tiktok.com/@suzu/video/1");
  });
  it("parses Vietnamese local datetimes as UTC+7", () => {
    expect(parseVietnamLocal("2026-09-17T09:00")?.toISOString()).toBe("2026-09-17T02:00:00.000Z");
    expect(parseVietnamLocal("nope")).toBeNull();
  });
});

describe("oauth state", () => {
  it("round-trips and rejects tampering / expiry", () => {
    const s = { orgId: "o", userId: "u", provider: "youtube" as const, nonce: "n", exp: Date.now() + 60_000 };
    const t = signState(s, "secret");
    expect(verifyState(t, "secret")).toEqual(s);
    expect(verifyState(t, "other")).toBeNull();
    expect(verifyState(t + "x", "secret")).toBeNull();
    expect(verifyState(signState({ ...s, exp: Date.now() - 1 }, "secret"), "secret")).toBeNull();
  });
});
