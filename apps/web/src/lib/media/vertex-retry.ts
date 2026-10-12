/**
 * When a Vertex AI `generateContent` call is tried again (pure, tested). Gemini models on the global endpoint run on
 * dynamic shared quota: a 429 RESOURCE_EXHAUSTED means the shared capacity (or the per-minute quota) is busy right
 * now, and Google's guidance is to back off and retry. 5xx answers are retried too; anything else is final.
 */

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BASE_MS = 4_000;
const MAX_WAIT_MS = 30_000;
/** First attempt included. */
export const VERTEX_MAX_ATTEMPTS = 6;

export const vertexRetryable = (status: number) => RETRYABLE.has(status);

/**
 * Wait before retry number `retry` (1 = the first retry): the server's Retry-After (seconds) when it sends one,
 * else 4 s · 2^(retry − 1) with jitter (50–100 %), so parallel panels that hit the limit together do not come
 * back together; never more than 30 s.
 */
export function vertexRetryDelayMs(retry: number, retryAfter: string | null, random: () => number = Math.random): number {
  const header = retryAfter == null || retryAfter.trim() === "" ? NaN : Number(retryAfter);
  if (Number.isFinite(header) && header >= 0) return Math.min(MAX_WAIT_MS, Math.round(header * 1000));
  const base = Math.min(MAX_WAIT_MS, BASE_MS * 2 ** Math.max(0, retry - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}
