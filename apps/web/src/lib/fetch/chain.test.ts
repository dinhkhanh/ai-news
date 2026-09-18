import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./providers", () => ({
  browserRenderingAvailable: vi.fn(async () => true),
  browserRenderContent: vi.fn(),
  browserRenderScreenshot: vi.fn(),
  firecrawlAvailable: vi.fn(async () => true),
  firecrawlScrape: vi.fn(),
  httpGetHtml: vi.fn(),
}));

import { BlockedError } from "./blocked";
import { fetchArticle, fetchOrder } from "./index";
import * as providers from "./providers";

const URL_ = "https://example.com/news/story-123.html";
const ARTICLE = `<html><head><title>Metro số 2</title></head><body><article>${Array.from({ length: 10 }, (_, i) => `<p>Đoạn ${i + 1}: Ủy ban nhân dân thành phố cho biết dự án đường sắt đô thị số hai sẽ khởi công vào năm sau với tổng mức đầu tư hơn bốn mươi bảy nghìn tỷ đồng.</p>`).join("")}</article></body></html>`;
const WALL = `<html><head><title>Access Denied</title></head><body><main>${Array.from({ length: 8 }, () => "<p>You do not have permission to access this page on this server, please check your browser, extensions, network and cookies and try again later.</p>").join("")}</main></body></html>`;

const p = vi.mocked(providers);

beforeEach(() => {
  vi.clearAllMocks();
  p.browserRenderingAvailable.mockResolvedValue(true);
  p.firecrawlAvailable.mockResolvedValue(true);
});

describe("fetchOrder", () => {
  it("keeps the whole chain behind the preferred provider", () => {
    expect(fetchOrder()).toEqual(["browser_rendering", "http", "firecrawl"]);
    expect(fetchOrder("http")).toEqual(["http", "browser_rendering", "firecrawl"]);
    expect(fetchOrder("firecrawl")).toEqual(["firecrawl", "browser_rendering", "http"]);
  });

  it("only: a direct run tries the picked provider and nothing else", () => {
    expect(fetchOrder("http", true)).toEqual(["http"]);
    expect(fetchOrder(undefined, true)).toEqual(["browser_rendering", "http", "firecrawl"]);
  });
});

describe("fetchArticle fall-through", () => {
  it("auto: a wordy block page from the first provider hands over to the next", async () => {
    p.browserRenderContent.mockResolvedValue({ html: WALL, ms: 1 });
    p.httpGetHtml.mockResolvedValue({ html: ARTICLE, finalUrl: URL_, ms: 1 });
    const out = await fetchArticle(URL_, { screenshot: false });
    expect(out.method).toBe("http");
    expect(out.attempts.map((a) => [a.method, a.ok, a.blocked ?? false])).toEqual([["browser_rendering", false, true], ["http", true, false]]);
    expect(p.firecrawlScrape).not.toHaveBeenCalled();
  });

  it("manual: the chosen provider goes first and the others follow when it is blocked", async () => {
    p.httpGetHtml.mockRejectedValue(new BlockedError("HTTP 403 from example.com"));
    p.browserRenderContent.mockRejectedValue(new Error("Browser Rendering content failed: HTTP 500"));
    p.firecrawlScrape.mockResolvedValue({ html: ARTICLE, markdown: null, metadata: { statusCode: 200 }, ms: 1 });
    const seen: string[] = [];
    const out = await fetchArticle(URL_, { preferred: "http", screenshot: false, onAttempt: (next) => void seen.push(next) });
    expect(seen).toEqual(["http", "browser_rendering", "firecrawl"]);
    expect(out.method).toBe("firecrawl");
    expect(out.attempts[0]).toMatchObject({ method: "http", ok: false, blocked: true });
    expect(out.attempts[1]).toMatchObject({ method: "browser_rendering", ok: false });
    expect(out.attempts[1].blocked).toBeUndefined();
  });

  it("fails with every reason when all providers are blocked, never keeping a wall as the article", async () => {
    p.browserRenderContent.mockResolvedValue({ html: WALL, ms: 1 });
    p.httpGetHtml.mockRejectedValue(new BlockedError("HTTP 403 from example.com"));
    p.firecrawlScrape.mockResolvedValue({ html: WALL, markdown: null, metadata: { statusCode: 403 }, ms: 1 });
    await expect(fetchArticle(URL_, { screenshot: false })).rejects.toThrow(/browser_rendering: blocked.*http: blocked: HTTP 403.*firecrawl: blocked: HTTP 403/);
  });
});
