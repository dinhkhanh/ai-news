import { describe, expect, it } from "vitest";
import { canonicalizeUrl, displayHost, isPrivateHost, safeNextPath } from "./url";

describe("canonicalizeUrl", () => {
  it("strips tracking params, fragments and default ports; sorts the rest", () => {
    expect(canonicalizeUrl("https://VnExpress.net:443/kinh-doanh/bai-viet-123.html?utm_source=fb&fbclid=abc&b=2&a=1#top")).toBe(
      "https://vnexpress.net/kinh-doanh/bai-viet-123.html?a=1&b=2",
    );
  });
  it("adds https, trims trailing slash and duplicate slashes", () => {
    expect(canonicalizeUrl("  tuoitre.vn//thoi-su//bai-1/ ")).toBe("https://tuoitre.vn/thoi-su/bai-1");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });
  it("rejects non-http and bare hosts", () => {
    expect(() => canonicalizeUrl("ftp://example.com/x")).toThrow();
    expect(() => canonicalizeUrl("localhost")).toThrow();
    expect(() => canonicalizeUrl("")).toThrow();
  });
  it("is idempotent", () => {
    const once = canonicalizeUrl("https://www.example.com/a/?utm_medium=x&z=1");
    expect(canonicalizeUrl(once)).toBe(once);
  });
});

describe("helpers", () => {
  it("displayHost drops www", () => {
    expect(displayHost("https://www.thanhnien.vn/x")).toBe("thanhnien.vn");
  });
  it("isPrivateHost blocks local ranges", () => {
    expect(isPrivateHost("http://127.0.0.1/")).toBe(true);
    expect(isPrivateHost("http://10.1.2.3/")).toBe(true);
    expect(isPrivateHost("http://192.168.1.1/")).toBe(true);
    expect(isPrivateHost("https://vnexpress.net/")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps paths inside the app", () => {
    expect(safeNextPath("/app/projects/1?tab=script")).toBe("/app/projects/1?tab=script");
    expect(safeNextPath("/admin")).toBe("/admin");
  });

  it("falls back for anything a browser would take off-site", () => {
    for (const next of ["//evil.tld", "/\\evil.tld", "https://evil.tld", "javascript:alert(1)", "evil.tld", "/\tevil", "", null, undefined]) {
      expect(safeNextPath(next), String(next)).toBe("/app");
    }
  });
});
