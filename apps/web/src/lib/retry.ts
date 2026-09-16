/**
 * Generic retry-with-backoff, plus the predicate for a known Remotion Lambda
 * flake: its headless browser occasionally gets a transient S3 AccessDenied
 * loading the site bundle (`Error while getting compositions`) even though
 * the object is reachable via plain HTTP and the SDK at the same moment.
 * Observed 2026-09-16: ~half of render attempts failed this way for a few
 * minutes, and every retry within seconds succeeded — see render-project.ts.
 * No server-only import so this is unit-tested directly.
 */

export type RetryOptions = {
  /** Total attempts including the first call. */
  attempts?: number;
  /** Base delay; attempt N waits delayMs * N before retrying. */
  delayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delayMs = 4000, isRetryable = () => true, sleep = defaultSleep } = opts;
  if (attempts < 1) throw new Error("attempts must be at least 1");
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isRetryable(err)) throw err;
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

export function isTransientRemotionSiteError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /error while getting compositions/i.test(message) && /accessdenied/i.test(message);
}
