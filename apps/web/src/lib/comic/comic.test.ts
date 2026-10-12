import { describe, expect, it } from "vitest";
import { comicDocSchema, type Panel, type Rect } from "@ai-news/video/comic";
import { tailGeometry } from "@ai-news/video/comic-view";
import { addPanel, applyPanelImage, buildDoc, deletePanel, docImageKeys, docStats, dropCast, editPanel, mergeCast, panelsToDraw, replacePage, type DocOptions } from "./doc";
import { formatOf, layoutPage, rowsFor, snapAspect } from "./layout";
import { balloonBox, baseFontSize, facesOnPage, letterPanel, MIN_FONT_SCALE, segmentHits, speakerPoint, wrapWords } from "./lettering";
import { estimateAdaptUsd, estimateDrawUsd, IMAGE_MODELS, imageModel, textModel } from "./models";
import { adaptUser, panelPrompt, pickRefs, refsNote, sheetPrompt, type ComicStyle } from "./prompts";
import { normaliseComicScript, slug, type ComicScript } from "./script";

const ids = () => {
  let n = 0;
  return (p: string) => `${p}${++n}`;
};

const inside = (r: Rect, outer: Rect) => r.x >= outer.x - 0.5 && r.y >= outer.y - 0.5 && r.x + r.w <= outer.x + outer.w + 0.5 && r.y + r.h <= outer.y + outer.h + 0.5;
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const a4 = formatOf("a4");
const opts: DocOptions = { format: a4, readingDirection: "ltr", language: "vi", font: "itim", credit: "Minh hoạ bởi AI (Gemini)" };

const script: ComicScript = {
  title: "Ngọn đèn lồng của bà",
  logline: "Lan tìm thấy chiếc đèn lồng cũ của bà.",
  cast: [
    { ref: "char-lan", name: "Lan", role: "cô bé", visual: "girl, 8, black bob, pink shirt", personality: "tò mò" },
    { ref: "Bà nội", name: "Bà nội", role: "bà", visual: "grandmother, 70, silver bun, purple ao dai", personality: "hiền" },
  ],
  settings: [{ id: "attic", name: "Gác xép", visual: "dusty wooden attic" }],
  pages: [
    {
      beat: "Lan lên gác",
      layout: "wide-top",
      panels: [
        { size: "wide", shot: "establishing", settingId: "attic", time: "day", mood: "dusty", characters: [{ ref: "char-lan", position: "left", action: "climbing", expression: "curious" }], description: "Wide attic", lettering: [{ kind: "caption", speaker: null, text: "Gác xép nhà bà." }] },
        { size: "medium", shot: "medium", settingId: "attic", time: "day", mood: "", characters: [{ ref: "char-lan", position: "center", action: "lifting a sheet", expression: "excited" }], description: "Lan lifts a sheet", lettering: [{ kind: "thought", speaker: "char-lan", text: "Đồ chơi Trung thu chắc ở trong này…" }] },
        { size: "small", shot: "close-up", settingId: "nowhere", time: "", mood: "", characters: [{ ref: "ghost", position: "right", action: "x", expression: "y" }], description: "Lantern", lettering: [{ kind: "sfx", speaker: "char-lan", text: "Sột soạt" }, { kind: "speech", speaker: "nobody", text: "  " }] },
        { size: "medium", shot: "close-up", settingId: "attic", time: "", mood: "", characters: [{ ref: "char-lan", position: "left", action: "holding lantern", expression: "surprised" }, { ref: "Bà nội", position: "right", action: "smiling", expression: "warm" }], description: "Both", lettering: [{ kind: "speech", speaker: "Bà nội", text: "Cháu tìm thấy nó rồi à? Chiếc đèn ấy còn già hơn cả bố cháu đấy." }] },
      ],
    },
    { beat: "empty", layout: "auto", panels: [] },
  ],
};

describe("models", () => {
  it("fall back to the defaults and estimate costs", () => {
    expect(textModel("nope").id).toBe("claude-opus-5-5");
    expect(imageModel(undefined).id).toBe("gemini-3.1-flash-image");
    expect(estimateDrawUsd("gemini-3.1-flash-image", 30, 0)).toBeCloseTo(30 * 0.0672, 6);
    expect(estimateDrawUsd("gemini-3-pro-image", 10)).toBeGreaterThan(estimateDrawUsd("gemini-3.1-flash-image", 10));
    expect(estimateAdaptUsd("claude-opus-5-5", 20000)).toBeGreaterThan(estimateAdaptUsd("claude-haiku-5-5", 20000));
    for (const m of IMAGE_MODELS) expect(m.aspectRatios).toContain("3:4");
  });
});

describe("layout", () => {
  it("gives wide and large panels their own row and puts small ones three to a row", () => {
    expect(rowsFor(["wide", "medium", "medium", "large"], "auto").map((r) => r.idx)).toEqual([[0], [1, 2], [3]]);
    expect(rowsFor(["small", "small", "small", "small"], "auto").map((r) => r.idx)).toEqual([[0, 1, 2], [3]]);
    expect(rowsFor(["medium", "medium", "medium"], "wide-top").map((r) => r.idx)).toEqual([[0], [1, 2]]);
    expect(rowsFor(["wide", "large", "small"], "grid").map((r) => r.idx)).toEqual([[0, 1], [2]]);
  });

  it("fills the page between the margins without overlaps, and mirrors it right to left", () => {
    const sizes = ["wide", "medium", "small", "medium", "medium"] as const;
    const { height, rects } = layoutPage(a4, [...sizes], "auto", "ltr");
    expect(height).toBe(a4.height);
    const page = { x: 0, y: 0, w: a4.width, h: a4.height };
    for (const r of rects) expect(inside(r, page)).toBe(true);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(intersects(rects[i], rects[j])).toBe(false);
    const rtl = layoutPage(a4, [...sizes], "auto", "rtl").rects;
    expect(rtl[1].x + rtl[1].w).toBe(a4.width - rects[1].x);
    // The first panel of a row is on the right in a manga.
    expect(rtl[1].x).toBeGreaterThan(rtl[2].x);
  });

  it("stacks webtoon panels and grows the page", () => {
    const { height, rects } = layoutPage(formatOf("webtoon"), ["wide", "tall", "medium"], "auto", "ltr");
    expect(rects[1].y).toBeGreaterThan(rects[0].y + rects[0].h);
    expect(height).toBeGreaterThan(rects[2].y + rects[2].h);
    expect(rects[1].h).toBeGreaterThan(rects[0].h);
  });

  it("supports a tall panel on the left", () => {
    const { rects } = layoutPage(a4, ["tall", "small", "small", "small"], "tall-left", "ltr");
    expect(rects[0].h).toBeGreaterThan(rects[1].h * 2);
    expect(rects[1].x).toBeGreaterThan(rects[0].x + rects[0].w);
  });

  it("snaps a panel to the closest supported aspect ratio", () => {
    const r = imageModel(null).aspectRatios;
    expect(snapAspect(1140, 500, r)).toBe("21:9");
    expect(snapAspect(600, 800, r)).toBe("3:4");
    expect(snapAspect(500, 500, r)).toBe("1:1");
    expect(snapAspect(300, 900, r)).toBe("9:16");
  });
});

describe("lettering", () => {
  it("wraps words and sizes balloons from their text", () => {
    expect(wrapWords("một hai ba bốn năm sáu", 8)).toEqual(["một hai", "ba bốn", "năm sáu"]);
    expect(wrapWords("siêu-dài-không-ngắt ok", 5)).toEqual(["siêu-dài-không-ngắt", "ok"]);
    const short = balloonBox("Chào!", "speech", 32, 500, "itim");
    const long = balloonBox("Cháu tìm thấy nó rồi à? Chiếc đèn ấy còn già hơn cả bố cháu đấy.", "speech", 32, 500, "itim");
    expect(long.h).toBeGreaterThan(short.h);
    expect(long.w).toBeLessThanOrEqual(500 + 1);
  });

  const panel = (over: Partial<Panel> = {}): Panel => ({
    id: "k",
    rect: { x: 50, y: 50, w: 700, h: 600 },
    script: { size: "medium", shot: "medium", settingId: null, time: "", mood: "", characters: [{ ref: "a", position: "left", action: "", expression: "" }, { ref: "b", position: "right", action: "", expression: "" }], description: "" },
    image: null,
    variants: [],
    error: null,
    lettering: [],
    ...over,
  });
  const balloon = (id: string, text: string, speaker: string | null = "a", kind: "speech" | "caption" | "sfx" = "speech") => ({ id, kind, speaker, text, rect: null, tail: null, fontSize: 32, manual: false });

  it("maps faces through the cover fit of the panel", () => {
    const p = panel({ rect: { x: 0, y: 0, w: 400, h: 400 }, image: { id: "i", key: "k", width: 800, height: 400, faces: [{ x: 0.5, y: 0.25, w: 0.1, h: 0.2 }] } });
    // 800×400 cover-fitted into 400×400: scale 1, 200 px cut on each side.
    expect(facesOnPage(p)[0]).toEqual({ x: 200, y: 100, w: 80, h: 80 });
  });

  it("places balloons inside the panel, in reading order, off the faces and off each other", () => {
    const p = panel({
      image: { id: "i", key: "k", width: 700, height: 600, faces: [{ x: 0.05, y: 0.05, w: 0.3, h: 0.35 }] },
      lettering: [balloon("1", "Bà ơi, cái đèn này của ai thế ạ?"), balloon("2", "Của bà đấy, cháu ạ.", "b")],
    });
    const out = letterPanel(p, { pageWidth: 1240, font: "itim", direction: "ltr" });
    const face = facesOnPage(p)[0];
    const [b1, b2] = out.lettering;
    for (const b of [b1, b2]) {
      expect(b.rect).not.toBeNull();
      expect(inside(b.rect!, p.rect)).toBe(true);
      expect(intersects(b.rect!, face)).toBe(false);
      expect(b.tail).not.toBeNull();
    }
    expect(intersects(b1.rect!, b2.rect!)).toBe(false);
    // The second speaker is on the right: their balloon's tail points right of the first one's.
    expect(b2.tail!.x).toBeGreaterThan(b1.tail!.x);
  });

  it("does not send a tail through another balloon", () => {
    const one = panel({ rect: { x: 0, y: 0, w: 500, h: 700 }, script: { ...panel().script, characters: [{ ref: "a", position: "center", action: "", expression: "" }] }, lettering: [balloon("1", "Bà ơi! Trong đèn có tờ giấy!"), balloon("2", "của ai nhỉ…")] });
    const out = letterPanel(one, { pageWidth: 1240, font: "itim", direction: "ltr" });
    const [b1, b2] = out.lettering;
    const c = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    expect(segmentHits(c(b1.rect!), b1.tail!, b2.rect!)).toBe(false);
    expect(segmentHits(c(b2.rect!), b2.tail!, b1.rect!)).toBe(false);
  });

  it("keeps hand-placed balloons where they are and avoids them", () => {
    const manual = { ...balloon("m", "Đặt tay"), rect: { x: 70, y: 70, w: 300, h: 120 }, manual: true };
    const out = letterPanel(panel({ lettering: [manual, balloon("2", "Tự động")] }), { pageWidth: 1240, font: "itim", direction: "ltr" });
    expect(out.lettering[0]).toEqual(manual);
    expect(intersects(out.lettering[1].rect!, manual.rect)).toBe(false);
  });

  it("gives captions and sound effects no tail and starts captions at the reading edge", () => {
    const out = letterPanel(panel({ lettering: [balloon("c", "Đêm Trung thu.", null, "caption"), balloon("s", "Bùm!", null, "sfx")] }), { pageWidth: 1240, font: "itim", direction: "rtl" });
    expect(out.lettering.every((b) => b.tail === null)).toBe(true);
    const c = out.lettering[0].rect!;
    expect(c.x + c.w).toBeGreaterThan(50 + 700 - 60);
  });

  it("shrinks and flags text that cannot fit", () => {
    const tiny = panel({ rect: { x: 0, y: 0, w: 220, h: 160 }, lettering: [balloon("1", "Một câu thoại rất dài không thể nào vừa được trong một khung tranh nhỏ xíu như thế này đâu bạn ơi.")] });
    const out = letterPanel(tiny, { pageWidth: 1240, font: "itim", direction: "ltr" });
    expect(out.lettering[0].overflow).toBe(true);
    expect(out.lettering[0].fontSize).toBeLessThan(baseFontSize(1240));
    expect(out.lettering[0].fontSize).toBeGreaterThanOrEqual(Math.round(baseFontSize(1240) * MIN_FONT_SCALE) - 1);
    expect(inside(out.lettering[0].rect!, tiny.rect)).toBe(true);
  });

  it("finds the speaker from the script's positions without faces", () => {
    const p = panel();
    expect(speakerPoint(p, "a")!.x).toBeLessThan(speakerPoint(p, "b")!.x);
    expect(speakerPoint(p, "zzz")).toBeNull();
  });

  it("draws the tail from the balloon edge to its tip", () => {
    const g = tailGeometry({ ...balloon("1", "x"), rect: { x: 0, y: 0, w: 200, h: 100 }, tail: { x: 100, y: 200 } });
    expect(g).not.toBeNull();
    expect(g!.base[1]).toBeLessThan(100);
    expect(g!.base[1]).toBeGreaterThan(50);
    expect(tailGeometry({ ...balloon("1", "x"), rect: { x: 0, y: 0, w: 200, h: 100 }, tail: { x: 100, y: 60 } })).toBeNull();
  });
});

describe("script normalisation", () => {
  it("keeps library ids, marks proposed characters, drops unknown refs, settings and empty lines", () => {
    const n = normaliseComicScript(script, ["char-lan"]);
    expect(n.cast.map((c) => c.ref)).toEqual(["char-lan", "new:ba-noi"]);
    const k = n.pages[0].panels;
    expect(k[3].lettering[0].speaker).toBe("new:ba-noi");
    expect(k[3].characters.map((c) => c.ref)).toEqual(["char-lan", "new:ba-noi"]);
    expect(k[2].characters).toEqual([]);
    expect(k[2].settingId).toBeNull();
    expect(k[2].lettering).toEqual([{ kind: "sfx", speaker: null, text: "Sột soạt" }]);
    expect(n.pages).toHaveLength(1);
  });

  it("slugs Vietnamese names", () => {
    expect(slug("Đức Anh Trần")).toBe("duc-anh-tran");
    expect(slug("!!!")).toBe("nv");
  });
});

describe("document", () => {
  const doc = buildDoc(normaliseComicScript(script, ["char-lan"]), opts, ids());

  it("builds a valid, laid-out, lettered document", () => {
    expect(comicDocSchema.safeParse(doc).success).toBe(true);
    expect(doc.cast.find((c) => c.ref === "char-lan")!.characterId).toBe("char-lan");
    expect(doc.cast.find((c) => c.ref === "new:ba-noi")!.characterId).toBeNull();
    expect(docStats(doc)).toMatchObject({ pages: 1, panels: 4, drawn: 0, balloons: 4 });
    expect(doc.pages[0].panels.every((k) => k.rect.w > 0)).toBe(true);
    expect(doc.pages[0].panels.flatMap((k) => k.lettering).every((b) => b.rect)).toBe(true);
    expect(panelsToDraw(doc)).toHaveLength(4);
  });

  it("applies a drawing, keeps variants and re-letters around the faces", () => {
    const k = doc.pages[0].panels[3];
    const img = { id: "img1", key: "media/o/comics/c/panels/a.png", width: 1000, height: 1000, faces: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }] };
    const d2 = applyPanelImage(doc, k.id, img);
    const k2 = d2.pages[0].panels[3];
    expect(k2.image?.id).toBe("img1");
    expect(k2.variants).toHaveLength(1);
    expect(docImageKeys(d2)).toEqual([img.key]);
    expect(applyPanelImage(d2, k.id, { ...img, id: "img2" }).pages[0].panels[3].variants).toHaveLength(2);
    expect(panelsToDraw(d2)).toHaveLength(3);
  });

  it("edits, adds and deletes panels, re-laying the page out", () => {
    const k = doc.pages[0].panels[1];
    const d2 = editPanel(doc, k.id, { description: " New ", size: "large", lettering: [{ kind: "speech", speaker: "char-lan", text: "Xin chào" }] }, ids());
    const k2 = d2.pages[0].panels[1];
    expect(k2.script.description).toBe("New");
    expect(k2.lettering.map((b) => b.text)).toEqual(["Xin chào"]);
    expect(k2.rect.w).toBeGreaterThan(k.rect.w);
    const d3 = addPanel(d2, d2.pages[0].id, "Extra", ids());
    expect(d3.pages[0].panels).toHaveLength(5);
    const d4 = deletePanel(d3, d3.pages[0].panels[4].id);
    expect(d4.pages[0].panels).toHaveLength(4);
    expect(deletePanel(buildDoc({ ...script, pages: [{ ...script.pages[0], panels: [script.pages[0].panels[0]] }] }, opts, ids()), "k2").pages).toHaveLength(0);
  });

  it("drops and merges cast members", () => {
    const dropped = dropCast(doc, "new:ba-noi");
    expect(dropped.cast.map((c) => c.ref)).toEqual(["char-lan"]);
    const b = dropped.pages[0].panels[3].lettering[0];
    expect(b).toMatchObject({ kind: "caption", speaker: null });
    const merged = mergeCast(doc, "new:ba-noi", "char-lan");
    expect(merged.pages[0].panels[3].script.characters.map((c) => c.ref)).toEqual(["char-lan"]);
    expect(merged.pages[0].panels[3].lettering[0].speaker).toBe("char-lan");
  });

  it("replaces one page and keeps its id", () => {
    const d2 = replacePage(doc, doc.pages[0].id, { beat: "Mới", layout: "splash", panels: [script.pages[0].panels[0]] }, ids());
    expect(d2.pages[0].id).toBe(doc.pages[0].id);
    expect(d2.pages[0].panels).toHaveLength(1);
    expect(d2.pages[0].beat).toBe("Mới");
  });
});

describe("prompts", () => {
  const style: ComicStyle = { id: null, name: "Webtoon", prompt: "clean digital line art, soft cel shading", negative: "photorealism", colourMode: "colour", storytellingNotes: "", referenceKeys: [] };
  const doc = buildDoc(normaliseComicScript(script, ["char-lan"]), opts, ids());

  it("orders and cuts reference images by importance", () => {
    const c = { sheets: ["s1", "s2"], setting: "set", style: ["st1"], previous: "prev" };
    expect(pickRefs(c, 3)).toEqual(["s1", "s2", "set"]);
    expect(pickRefs({ ...c, previous: "s1" }, 10)).toEqual(["s1", "s2", "set", "st1"]);
    expect(refsNote(c, ["s1", "prev"])).toContain("2) the previous panel");
    expect(refsNote(c, [])).toBeNull();
  });

  it("builds the same character block in every panel, and never asks for text in the picture", () => {
    const [k1, k2] = doc.pages[0].panels;
    const p1 = panelPrompt(doc, k1, style, { aspect: "21:9", refsNote: null });
    const p2 = panelPrompt(doc, k2, style, { aspect: "3:4", refsNote: "Reference images…", instruction: "closer" });
    const block = "Lan: girl, 8, black bob, pink shirt";
    expect(p1).toContain(block);
    expect(p2).toContain(block);
    expect(p1).toContain("Setting: Gác xép");
    expect(p2).toContain("Direction for this drawing: closer");
    expect(p1).toMatch(/no text of any kind/);
    expect(sheetPrompt(doc.cast[0], { ...style, colourMode: "bw" })).toContain("Black and white only");
  });

  it("puts the story, the length and the cast in the adaptation request", () => {
    const u = adaptUser({ story: "Ngày xưa…", language: "vi", pages: null, audience: "kids", dialogue: "low", free: false, readingDirection: "rtl", style: { name: "Manga", storytellingNotes: "silent panels", colourMode: "bw" }, cast: [{ id: "c1", name: "Lan", role: "", visual: "", personality: "" }], title: null });
    expect(u).toContain("<story>\nNgày xưa…\n</story>");
    expect(u).toContain("5 to 10 pages");
    expect(u).toContain('id "c1"');
    expect(u).toContain("right to left");
    expect(u).toContain("faithful");
  });
});
