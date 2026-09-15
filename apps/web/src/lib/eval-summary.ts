/** Pure eval scoring shared by the Inngest eval run and the admin UI. */
export type EvalArticleResult = {
  articleId: string;
  title: string;
  ok: boolean;
  error?: string;
  scenes?: number;
  estimatedDurationSec?: number;
  durationDeviationPct?: number;
  supported?: number;
  partial?: number;
  unsupported?: number;
  evidenceMissing?: number;
  expectationsMissed?: string[];
  forbiddenMentioned?: string[];
  scriptCostUsd?: number;
  faithfulnessCostUsd?: number;
  latencyMs?: number;
  scriptTitle?: string;
  hook?: string;
};

export type EvalSummary = {
  articles: number;
  failed: number;
  avgDurationDeviationPct: number;
  unsupportedRate: number;
  partialRate: number;
  expectationPassRate: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  /** 0-100; the promotion UI shows this next to the previous promoted version's score. */
  score: number;
};

export function summarise(results: EvalArticleResult[]): EvalSummary {
  const ok = results.filter((r) => r.ok);
  const scenes = ok.reduce((a, r) => a + (r.scenes ?? 0), 0);
  const unsupported = ok.reduce((a, r) => a + (r.unsupported ?? 0), 0);
  const partial = ok.reduce((a, r) => a + (r.partial ?? 0), 0);
  const expectationChecks = ok.filter((r) => r.expectationsMissed !== undefined);
  const expectationPass = expectationChecks.filter((r) => (r.expectationsMissed?.length ?? 0) === 0 && (r.forbiddenMentioned?.length ?? 0) === 0).length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const unsupportedRate = scenes ? unsupported / scenes : 0;
  const partialRate = scenes ? partial / scenes : 0;
  const avgDur = avg(ok.map((r) => Math.abs(r.durationDeviationPct ?? 0)));
  const expectationPassRate = expectationChecks.length ? expectationPass / expectationChecks.length : 1;
  const failRate = results.length ? (results.length - ok.length) / results.length : 1;
  const score = Math.round(100 * Math.max(0, 1 - failRate - unsupportedRate * 1.5 - partialRate * 0.5 - Math.min(0.3, avgDur / 100) - (1 - expectationPassRate) * 0.5));
  return {
    articles: results.length,
    failed: results.length - ok.length,
    avgDurationDeviationPct: Math.round(avgDur * 10) / 10,
    unsupportedRate: Math.round(unsupportedRate * 1000) / 1000,
    partialRate: Math.round(partialRate * 1000) / 1000,
    expectationPassRate: Math.round(expectationPassRate * 1000) / 1000,
    totalCostUsd: Math.round(results.reduce((a, r) => a + (r.scriptCostUsd ?? 0) + (r.faithfulnessCostUsd ?? 0), 0) * 10000) / 10000,
    avgLatencyMs: Math.round(avg(ok.map((r) => r.latencyMs ?? 0))),
    score,
  };
}
