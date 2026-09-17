import { describe, expect, it } from "vitest";
import { BlockedError, detectBlock, isBlockStatus } from "./blocked";
import { extractFromHtml } from "./readability";

const URL_ = "https://example.com/news/story-123.html";
const check = (html: string, extra: Partial<Parameters<typeof detectBlock>[0]> = {}) => {
  const ex = extractFromHtml(html, URL_);
  return detectBlock({ html, text: ex.text, wordCount: ex.wordCount, ...extra });
};
const filler = (n: number) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} explains why the request could not be completed and lists many generic hints about browsers, extensions, networks and cookies for the visitor.</p>`).join("");
const article = (n: number, title = "Metro số 2 khởi công năm sau") =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>${Array.from({ length: n }, (_, i) => `<p>Đoạn ${i + 1}: Ủy ban nhân dân thành phố cho biết dự án đường sắt đô thị số hai sẽ khởi công vào năm sau với tổng mức đầu tư hơn bốn mươi bảy nghìn tỷ đồng.</p>`).join("")}</article></body></html>`;

describe("detectBlock", () => {
  it("passes a normal article", () => {
    expect(check(article(8))).toBeNull();
  });

  it("catches a Cloudflare challenge by title and markup", () => {
    expect(check(`<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script><p>Enable JavaScript and cookies to continue</p></body></html>`)).toMatch(/challenge/i);
    expect(check(`<html><head><title>example.com</title></head><body><div id="challenge-error-text">x</div></body></html>`)).toBe("Cloudflare challenge");
  });

  it("catches a wordy block page that would pass the word-count check", () => {
    const html = `<html><head><title>Access Denied</title></head><body><main><h1>Access Denied</h1>${filler(8)}</main></body></html>`;
    expect(extractFromHtml(html, URL_).wordCount).toBeGreaterThan(120);
    expect(check(html)).toMatch(/access denied/i);
  });

  it("catches vendor captcha pages", () => {
    expect(check(`<html><head><title>example.com</title></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?x=1"></iframe></body></html>`)).toBe("DataDome captcha");
    expect(check(`<html><body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human</p></body></html>`)).toBe("PerimeterX captcha");
  });

  it("catches wall phrases in English and Vietnamese", () => {
    expect(check(`<html><body><p>Our systems have detected unusual traffic from your computer network.</p></body></html>`)).toBe("bot wall");
    expect(check(`<html><body><div>Vui lòng xác minh bạn không phải là robot để tiếp tục.</div></body></html>`)).toBe("block page");
  });

  it("uses the target status and a redirect to a login wall", () => {
    expect(check(article(2), { status: 403 })).toBe("HTTP 403");
    expect(check(article(2), { status: 200 })).toBeNull();
    expect(check(article(2), { requestedUrl: URL_, finalUrl: "https://example.com/login?next=/news/story-123.html" })).toMatch(/redirected to example\.com\/login/);
    expect(check(article(2), { requestedUrl: URL_, finalUrl: "https://www.example.com/news/story-123.html" })).toBeNull();
  });

  it("never flags a long article, even one about captchas", () => {
    const html = article(12, "Access denied: vì sao captcha ngày càng khó").replace("</article>", "<p>Are you a robot? Verify you are human, the page asks.</p></article>");
    expect(extractFromHtml(html, URL_).wordCount).toBeGreaterThanOrEqual(300);
    expect(check(html, { status: 403 })).toBeNull();
  });

  it("does not flag short articles whose title merely starts with an ambiguous word", () => {
    expect(check(article(3, "Blocked roads reopen after the storm"))).toBeNull();
    expect(check(article(3, "Security check queues grow at Tan Son Nhat"))).toBeNull();
  });
});

describe("block helpers", () => {
  it("knows which statuses mean refused", () => {
    expect([401, 403, 429, 451, 503].every(isBlockStatus)).toBe(true);
    expect([200, 404, 500, null, undefined].some(isBlockStatus)).toBe(false);
  });
  it("labels the error", () => {
    expect(new BlockedError("HTTP 403 from example.com").message).toBe("blocked: HTTP 403 from example.com");
  });
});
