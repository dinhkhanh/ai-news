import { describe, expect, it, vi } from "vitest";
import { isTransientRemotionSiteError, withRetry } from "./retry";

const remotionSiteError = () =>
  new Error(
    'Error while getting compositions: Tried to go to https://remotionlambda-apsoutheast1-11mkpcsshx.s3.ap-southeast-1.amazonaws.com/sites/ai-news-v0-3-0/index.html\n' +
      '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
  );

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable failure with increasing backoff, then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(remotionSiteError()).mockRejectedValueOnce(remotionSiteError()).mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { attempts: 3, delayMs: 1000, isRetryable: isTransientRemotionSiteError, sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it("throws once attempts are exhausted", async () => {
    const err = remotionSiteError();
    const fn = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { attempts: 3, isRetryable: isTransientRemotionSiteError, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const err = new Error("Render did not finish within the polling budget");
    const fn = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn();
    await expect(withRetry(fn, { attempts: 3, isRetryable: isTransientRemotionSiteError, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects an invalid attempts count", async () => {
    await expect(withRetry(vi.fn(), { attempts: 0 })).rejects.toThrow("attempts must be at least 1");
  });
});

describe("isTransientRemotionSiteError", () => {
  it("matches the known Remotion/S3 flake", () => {
    expect(isTransientRemotionSiteError(remotionSiteError())).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isTransientRemotionSiteError(new Error("Remotion render failed: some other reason"))).toBe(false);
    expect(isTransientRemotionSiteError(new Error("AccessDenied"))).toBe(false);
    expect(isTransientRemotionSiteError("not an Error instance")).toBe(false);
  });
});
