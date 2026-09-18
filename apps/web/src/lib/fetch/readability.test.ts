import { describe, expect, it } from "vitest";
import { countWords, decodeEntities, extractFromHtml, markdownToText, normaliseText } from "./readability";

const para = (n: number) =>
  Array.from({ length: n }, (_, i) => `<p>Đoạn ${i + 1}: Ủy ban nhân dân Thành phố Hồ Chí Minh cho biết dự án đường sắt đô thị số hai sẽ khởi công vào năm sau, với tổng mức đầu tư hơn bốn mươi bảy nghìn tỷ đồng và dự kiến hoàn thành sau sáu năm thi công.</p>`).join("\n");

const ARTICLE = `<!doctype html><html lang="vi"><head>
<title>Site title | VnExpress</title>
<link rel="canonical" href="https://vnexpress.net/metro-so-2-khoi-cong-4800000.html?utm_source=x">
<meta property="og:title" content="Metro số 2 khởi công năm sau">
<meta property="og:site_name" content="VnExpress">
<meta property="og:image" content="/images/metro.jpg">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="article:published_time" content="2026-09-15T08:30:00+07:00">
<meta name="author" content="Lê Tuyết">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Metro số 2 khởi công năm sau","datePublished":"2026-09-15T08:30:00+07:00","author":{"@type":"Person","name":"Lê Tuyết"},"image":["https://i-vnexpress.vnecdn.net/metro.jpg"]}</script>
</head><body>
<header><nav><a href="/">Trang chủ</a><a href="/kinh-doanh">Kinh doanh</a></nav></header>
<article>
<h1>Metro số 2 khởi công năm sau</h1>
${para(8)}
<figure><img data-src="/photos/ga-ben-thanh.jpg" width="680" height="400" alt="Ga Bến Thành"><img src="/pixel.gif" width="1" height="1"></figure>
</article>
<footer><p>© 2026 VnExpress</p></footer>
</body></html>`;

describe("extractFromHtml", () => {
  const out = extractFromHtml(ARTICLE, "https://vnexpress.net/metro-so-2-khoi-cong-4800000.html");

  it("extracts body text and metadata", () => {
    expect(out.wordCount).toBeGreaterThan(200);
    expect(out.text).toContain("Đoạn 1");
    expect(out.text).toContain("Đoạn 8");
    expect(out.text).not.toContain("Trang chủ");
    expect(out.title).toBe("Metro số 2 khởi công năm sau");
    expect(out.byline).toBe("Lê Tuyết");
    expect(out.siteName).toBe("VnExpress");
    expect(out.publishedAt?.toISOString()).toBe("2026-09-15T01:30:00.000Z");
    expect(out.lang).toBe("vi");
    expect(out.canonicalUrl).toBe("https://vnexpress.net/metro-so-2-khoi-cong-4800000.html?utm_source=x");
  });

  it("collects absolute image URLs and drops pixels/gifs", () => {
    const urls = out.images.map((i) => i.url);
    expect(urls[0]).toBe("https://vnexpress.net/images/metro.jpg");
    expect(urls).toContain("https://i-vnexpress.vnecdn.net/metro.jpg");
    expect(urls).toContain("https://vnexpress.net/photos/ga-ben-thanh.jpg");
    expect(urls.some((u) => u.includes("pixel.gif"))).toBe(false);
  });

  it("has no flags for a normal article", () => {
    expect(out.flags).toEqual({});
  });

  it("flags paywalled, live-blog and video-only pages", () => {
    const paywalled = extractFromHtml(
      `<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".paywall"}}</script></head><body><article><p>Chỉ có phần mở đầu của bài viết hiển thị cho người chưa đăng ký, phần còn lại bị che bởi tường phí của tờ báo.</p></article></body></html>`,
      "https://example.com/a",
    );
    expect(paywalled.flags.paywall).toBe(true);
    expect(paywalled.flags.short).toBe(true);

    const live = extractFromHtml(`<html><head><script type="application/ld+json">{"@type":"LiveBlogPosting"}</script></head><body><article>${para(6)}</article></body></html>`, "https://example.com/live");
    expect(live.flags.liveBlog).toBe(true);
    expect(extractFromHtml(`<html><body><article>${para(6)}</article></body></html>`, "https://example.com/truc-tiep/bong-da").flags.liveBlog).toBe(true);

    const video = extractFromHtml(
      `<html><head><meta property="og:type" content="video.other"></head><body><video src="a.mp4"></video><p>Xem video về lễ khởi công.</p></body></html>`,
      "https://example.com/v",
    );
    expect(video.flags.videoOnly).toBe(true);
  });

  it("decodes HTML entities inside JSON-LD strings (baochinhphu.vn)", () => {
    const html = ARTICLE.replace(/"headline":"[^"]*"/, '"headline":"Ph&#243; Thủ tướng hội đ&#224;m với &quot;đối t&aacute;c&quot; v&#xE0; b&#225;o ch&#237; &amp; c&#244;ng ch&#250;ng"').replace('"name":"Lê Tuyết"', '"name":"L&#234; Tuyết"');
    const encoded = extractFromHtml(html, "https://baochinhphu.vn/x.htm");
    expect(encoded.title).toBe('Phó Thủ tướng hội đàm với "đối tác" và báo chí & công chúng');
    expect(encoded.byline).toBe("Lê Tuyết");
  });

  it("survives garbage input", () => {
    const junk = extractFromHtml("<not html at all", "https://example.com/x");
    expect(junk.text).toBe("");
    expect(junk.wordCount).toBe(0);
  });
});

describe("text helpers", () => {
  it("countWords handles Vietnamese syllables and punctuation", () => {
    expect(countWords("Thành phố Hồ Chí Minh, 15/9 - 2026!")).toBe(7);
    expect(countWords("   ")).toBe(0);
  });
  it("normaliseText collapses whitespace but keeps paragraphs", () => {
    expect(normaliseText("a  b\r\n\r\n\r\n\tc \n d")).toBe("a b\n\nc\nd");
  });
  it("decodeEntities leaves plain text, tags and bare ampersands as they are", () => {
    expect(decodeEntities("Vàng & đô la: GDP < 5% <b>năm</b> nay")).toBe("Vàng & đô la: GDP < 5% <b>năm</b> nay");
    expect(decodeEntities("GDP &lt; 5% &amp; l&#227;i suất <i>giảm</i>")).toBe("GDP < 5% & lãi suất <i>giảm</i>");
  });
  it("markdownToText strips markdown syntax", () => {
    expect(markdownToText("# Title\n\nSome **bold** and [a link](https://x.y) ![img](i.png)\n\n- item")).toBe("Title\n\nSome bold and a link\n\nitem");
  });
});
