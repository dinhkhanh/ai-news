import { describe, expect, it } from "vitest";
import { summarise } from "@/lib/eval-summary";
import { heuristicLanguage } from "@/lib/language";
import { DEFAULT_TEMPLATES, toneGuidance } from "@/lib/prompts/defaults";
import { findRange } from "@/lib/text-match";
import { evidenceAppears } from "./evidence";
import { placeholdersIn, renderTemplate } from "./render";
import { normaliseScript, ScriptSchema, type Script } from "./schemas";

describe("renderTemplate", () => {
  it("substitutes known placeholders, blanks null, leaves unknown visible", () => {
    expect(renderTemplate("A {{duration_sec}}s {{ tone }} {{missing}} [{{nul}}]", { duration_sec: 60, tone: "news", nul: null })).toBe("A 60s news {{missing}} []");
  });
  it("lists placeholders once", () => {
    expect(placeholdersIn("{{a}} {{b}} {{ a }}")).toEqual(["a", "b"]);
  });
  it("built-in templates only use known placeholders", () => {
    for (const t of DEFAULT_TEMPLATES) {
      for (const p of placeholdersIn(t.body)) expect(["language", "duration_sec", "tone", "tone_guidance"]).toContain(p);
      expect(t.body.length).toBeGreaterThan(400);
    }
    expect(toneGuidance("urgent", "vi")).toMatch(/nóng/);
    expect(toneGuidance("unknown-tone", "en")).toMatch(/Punchy/); // unknown tone → the first (default) tone
  });
});

const raw: Script = {
  title: "  Metro số 2  ",
  scenes: [
    { id: "x", kind: "hook", voiceover: " Mở đầu ", onScreenText: "Metro số 2", brollTerms: [" city aerial ", ""], durationSec: 4.26, supportingSentence: "  " },
    { id: "y", kind: "body", voiceover: "Thân bài", onScreenText: "47.000 tỷ", brollTerms: ["construction site"], durationSec: 0.2, supportingSentence: "Tổng mức đầu tư hơn 47 nghìn tỷ đồng." },
    { id: "z", kind: "cta", voiceover: "Theo dõi", onScreenText: "Theo VnExpress", brollTerms: [], durationSec: 3, supportingSentence: null },
  ],
  estimatedDurationSec: 99,
  metadata: {
    youtube: { title: "T", description: "D", hashtags: ["#Shorts", "metro so 2", "#Shorts"] },
    facebook: { title: "T", description: "D", hashtags: [] },
    tiktok: { title: "T", description: "D", hashtags: ["tin"] },
  },
  sensitiveTopic: false,
  notes: "  ",
};

describe("normaliseScript", () => {
  const s = normaliseScript(raw);
  it("renumbers scenes, trims, clamps durations and recomputes the total", () => {
    expect(s.scenes.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s.scenes[0].voiceover).toBe("Mở đầu");
    expect(s.scenes[0].brollTerms).toEqual(["city aerial"]);
    expect(s.scenes[0].supportingSentence).toBeNull();
    expect(s.scenes[0].durationSec).toBe(4.3);
    expect(s.scenes[1].durationSec).toBe(1);
    expect(s.estimatedDurationSec).toBe(8.3);
    expect(s.notes).toBeNull();
    expect(s.title).toBe("Metro số 2");
  });
  it("dedupes hashtags without the # prefix", () => {
    expect(s.metadata.youtube.hashtags).toEqual(["Shorts", "metroso2"]);
  });
  it("still validates against the schema", () => {
    expect(ScriptSchema.safeParse(s).success).toBe(true);
  });
});

describe("evidence matching", () => {
  const article = "Ủy ban nhân dân TP HCM cho biết dự án “Metro số 2” khởi công năm 2027.\nTổng mức đầu tư hơn 47.000 tỷ đồng.";
  it("evidenceAppears tolerates quotes, case and whitespace", () => {
    expect(evidenceAppears(article, 'dự án "metro số 2"   khởi công năm 2027')).toBe(true);
    expect(evidenceAppears(article, "khởi công năm 2028")).toBe(false);
    expect(evidenceAppears(article, null)).toBe(false);
  });
  it("evidenceAppears accepts two joined sentences that each appear", () => {
    expect(evidenceAppears(article, "khởi công năm 2027. Tổng mức đầu tư hơn 47.000 tỷ đồng.")).toBe(true);
  });
  it("findRange returns the original offsets", () => {
    const r = findRange(article, "Tổng mức đầu tư hơn 47.000 tỷ đồng");
    expect(r).not.toBeNull();
    expect(article.slice(r![0], r![1])).toBe("Tổng mức đầu tư hơn 47.000 tỷ đồng");
    expect(findRange(article, "không có trong bài này đâu nhé")).toBeNull();
    expect(findRange(article, "short")).toBeNull();
  });
});

describe("heuristicLanguage", () => {
  it("detects Vietnamese by diacritics", () => {
    expect(heuristicLanguage("Thành phố Hồ Chí Minh khởi công tuyến metro số hai vào năm sau.")).toBe("vi");
    expect(heuristicLanguage("The city breaks ground on its second metro line next year.")).toBe("en");
  });
});

describe("summarise", () => {
  it("scores a clean run high and a broken run low", () => {
    const good = summarise([
      { articleId: "a", title: "A", ok: true, scenes: 6, estimatedDurationSec: 61, durationDeviationPct: 1.7, supported: 6, partial: 0, unsupported: 0, expectationsMissed: [], forbiddenMentioned: [], scriptCostUsd: 0.1, faithfulnessCostUsd: 0.05, latencyMs: 40000 },
      { articleId: "b", title: "B", ok: true, scenes: 5, estimatedDurationSec: 58, durationDeviationPct: -3.3, supported: 5, partial: 0, unsupported: 0, expectationsMissed: [], forbiddenMentioned: [], scriptCostUsd: 0.1, faithfulnessCostUsd: 0.05, latencyMs: 30000 },
    ]);
    expect(good.score).toBeGreaterThanOrEqual(95);
    expect(good.failed).toBe(0);
    expect(good.totalCostUsd).toBe(0.3);
    expect(good.avgLatencyMs).toBe(35000);
    const bad = summarise([
      { articleId: "a", title: "A", ok: false, error: "boom" },
      { articleId: "b", title: "B", ok: true, scenes: 4, estimatedDurationSec: 90, durationDeviationPct: 50, supported: 1, partial: 1, unsupported: 2, expectationsMissed: ["x"], forbiddenMentioned: [], scriptCostUsd: 0.1, faithfulnessCostUsd: 0.05, latencyMs: 10000 },
    ]);
    expect(bad.score).toBeLessThan(20);
    expect(bad.failed).toBe(1);
    expect(bad.unsupportedRate).toBe(0.5);
    expect(bad.expectationPassRate).toBe(0);
  });
  it("handles an empty run", () => {
    expect(summarise([]).score).toBe(0);
  });
});
