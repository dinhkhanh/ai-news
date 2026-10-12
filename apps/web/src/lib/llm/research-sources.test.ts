import { describe, expect, it } from "vitest";
import { briefTitle, collectSources, creditLine, normaliseBrief, sourceKey, usedSources } from "./research-sources";

describe("normaliseBrief", () => {
  it("collapses spacing and blank runs, keeps paragraphs", () => {
    expect(normaliseBrief("  giá vàng\r\n\r\n\r\n\r\nhôm  nay \t ")).toBe("giá vàng\n\nhôm nay");
  });
  it("cuts very long briefs", () => {
    expect(normaliseBrief("a ".repeat(3000)).length).toBeLessThanOrEqual(2000);
  });
});

describe("briefTitle", () => {
  it("uses the first line", () => {
    expect(briefTitle("Metro số 2 TP.HCM\nGiọng hào hứng")).toBe("Metro số 2 TP.HCM");
  });
  it("cuts a long line at a word", () => {
    const t = briefTitle("Tổng hợp những thay đổi quan trọng nhất của luật đất đai sửa đổi có hiệu lực từ tháng tới và ảnh hưởng tới người mua nhà");
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(91);
    expect(t).not.toMatch(/\s…$/);
  });
});

describe("sourceKey", () => {
  it("ignores scheme, www, trailing slash and tracking", () => {
    expect(sourceKey("https://www.vnexpress.net/a-1.html/?utm_source=x")).toBe(sourceKey("http://vnexpress.net/a-1.html"));
    expect(sourceKey("https://example.com/a?id=2")).not.toBe(sourceKey("https://example.com/a?id=3"));
  });
});

describe("collectSources", () => {
  const content = [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "s1",
      content: [
        { type: "web_search_result", url: "https://vnexpress.net/a.html", title: "Bài A", page_age: "2 days ago", encrypted_content: "x" },
        { type: "web_search_result", url: "https://tuoitre.vn/b.htm", title: "Bài B", page_age: null, encrypted_content: "x" },
      ],
    },
    { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: "https://www.vnexpress.net/a.html", content: { type: "document", title: "Bài A (đầy đủ)" } } },
    { type: "web_fetch_tool_result", tool_use_id: "f2", content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" } },
    { type: "text", text: "…", citations: [{ type: "web_search_result_location", url: "https://reuters.com/c", title: "C", cited_text: "…" }, { type: "char_location" }] },
    { type: "text", text: "no citations" },
  ];

  it("keeps every page the tools returned, once, in order", () => {
    const s = collectSources(content);
    expect(s.map((x) => x.url)).toEqual(["https://vnexpress.net/a.html", "https://tuoitre.vn/b.htm", "https://reuters.com/c"]);
    expect(s[0]).toMatchObject({ title: "Bài A", pageAge: "2 days ago" });
  });

  it("reads links printed by the web tools' filtering code", () => {
    const s = collectSources([{ type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", stdout: "1. Giá vàng (https://vnexpress.net/gia-vang.html), 2. https://cafef.vn/x.chn.", stderr: "", return_code: 0 } }]);
    expect(s.map((x) => x.url)).toEqual(["https://vnexpress.net/gia-vang.html", "https://cafef.vn/x.chn"]);
  });

  it("skips non-web addresses", () => {
    expect(collectSources([{ type: "web_search_tool_result", content: [{ type: "web_search_result", url: "javascript:alert(1)", title: "x" }] }])).toEqual([]);
  });
});

describe("usedSources", () => {
  const found = [
    { url: "https://vnexpress.net/a.html", title: "Bài A", siteName: null },
    { url: "https://tuoitre.vn/b.htm", title: null, siteName: null },
  ];

  it("keeps only claimed pages the tools returned, with the model's outlet name", () => {
    const s = usedSources(
      [
        { url: "http://www.tuoitre.vn/b.htm/", outlet: "Tuổi Trẻ", title: "Bài B" },
        { url: "https://made-up.example/x", outlet: "Invented" },
        { url: "https://tuoitre.vn/b.htm", outlet: "Tuổi Trẻ" },
      ],
      found,
    );
    expect(s).toEqual([{ url: "https://tuoitre.vn/b.htm", title: "Bài B", siteName: "Tuổi Trẻ" }]);
  });

  it("falls back to the pages found when nothing matches, capped", () => {
    expect(usedSources([{ url: "https://made-up.example/x" }], found)).toHaveLength(2);
    const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://site${i}.com/a`, title: null, siteName: null }));
    expect(usedSources([], many)).toHaveLength(12);
  });
});

describe("creditLine", () => {
  it("names distinct outlets, host when unnamed, at most three", () => {
    expect(
      creditLine([
        { url: "https://vnexpress.net/a", title: null, siteName: "VnExpress" },
        { url: "https://vnexpress.net/b", title: null, siteName: "vnexpress" },
        { url: "https://www.reuters.com/c", title: null, siteName: null },
      ]),
    ).toBe("VnExpress, reuters.com");
    expect(creditLine(["A", "B", "C", "D"].map((n) => ({ url: `https://${n}.com`, title: null, siteName: n })))).toBe("A, B, C…");
    expect(creditLine([])).toBeNull();
  });
});
