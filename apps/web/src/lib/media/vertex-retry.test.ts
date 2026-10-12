import { describe, expect, it } from "vitest";
import { vertexRetryDelayMs, vertexRetryable } from "./vertex-retry";

describe("vertexRetryable", () => {
  it("retries rate limits and server errors only", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(vertexRetryable(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 413]) expect(vertexRetryable(s)).toBe(false);
  });
});

describe("vertexRetryDelayMs", () => {
  it("doubles from 4 s with jitter between half and the full step", () => {
    expect(vertexRetryDelayMs(1, null, () => 1)).toBe(4_000);
    expect(vertexRetryDelayMs(1, null, () => 0)).toBe(2_000);
    expect(vertexRetryDelayMs(2, null, () => 1)).toBe(8_000);
    expect(vertexRetryDelayMs(3, null, () => 1)).toBe(16_000);
  });

  it("never waits more than 30 s", () => {
    expect(vertexRetryDelayMs(5, null, () => 1)).toBe(30_000);
    expect(vertexRetryDelayMs(1, "120", () => 1)).toBe(30_000);
  });

  it("follows Retry-After in seconds and ignores a date or junk", () => {
    expect(vertexRetryDelayMs(3, "7", () => 1)).toBe(7_000);
    expect(vertexRetryDelayMs(1, "0", () => 1)).toBe(0);
    expect(vertexRetryDelayMs(1, "Wed, 21 Oct 2026 07:28:00 GMT", () => 1)).toBe(4_000);
    expect(vertexRetryDelayMs(1, "", () => 1)).toBe(4_000);
  });
});
