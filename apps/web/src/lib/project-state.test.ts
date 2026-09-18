import { describe, expect, it } from "vitest";
import { BUSY_STALE_MS, directRunAllowed, eventSuperseded, QUEUE_SLOW_MS, queuedForMs, startProgress } from "./project-state";

const T0 = Date.parse("2026-09-18T16:20:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const queued = { startedAt: iso(T0), at: iso(T0), label: "Đang xếp hàng…", pct: 0 };

describe("queuedForMs", () => {
  it("counts from the moment the step was queued until something reports", () => {
    expect(queuedForMs(queued, T0 + 120_000)).toBe(120_000);
    expect(queuedForMs(startProgress(), Date.now() + 5000)).toBeGreaterThanOrEqual(5000);
  });

  it("is null once the function has reported, for a direct run, and when idle", () => {
    expect(queuedForMs({ ...queued, at: iso(T0 + 2000), label: "Mở dự án", pct: 5 }, T0 + 120_000)).toBeNull();
    expect(queuedForMs({ ...queued, direct: true }, T0 + 120_000)).toBeNull();
    expect(queuedForMs(null, T0)).toBeNull();
    expect(queuedForMs({ label: "no timestamps" }, T0)).toBeNull();
  });
});

describe("directRunAllowed", () => {
  const project = (busyStep: string | null, busyProgress: typeof queued | null, updatedAt = T0) => ({ busyStep, busyProgress, updatedAt: new Date(updatedAt) });

  it("waits for the queue first, then lets a direct run take the step over", () => {
    expect(directRunAllowed(project("fetch", queued), "fetch", T0 + QUEUE_SLOW_MS - 1)).toBe(false);
    expect(directRunAllowed(project("fetch", queued), "fetch", T0 + QUEUE_SLOW_MS)).toBe(true);
  });

  it("never interrupts a step that is running", () => {
    const running = { ...queued, at: iso(T0 + 3000), label: "Lấy nội dung bài", pct: 10 };
    expect(directRunAllowed(project("fetch", running, T0 + 3000), "fetch", T0 + 5 * 60_000)).toBe(false);
  });

  it("takes over a step that went quiet, but only the step that was requested", () => {
    const running = { ...queued, at: iso(T0 + 3000) };
    expect(directRunAllowed(project("script", running, T0 + 3000), "script", T0 + 3000 + BUSY_STALE_MS + 1)).toBe(true);
    expect(directRunAllowed(project("script", queued), "fetch", T0 + QUEUE_SLOW_MS)).toBe(false);
    expect(directRunAllowed(project(null, null), "fetch", T0 + QUEUE_SLOW_MS)).toBe(false);
  });
});

describe("eventSuperseded", () => {
  it("runs an event whose step has no newer result", () => {
    expect(eventSuperseded(T0, {})).toBe(false);
    expect(eventSuperseded(T0, { latestResultAt: new Date(T0 - 60_000) })).toBe(false);
    expect(eventSuperseded(undefined, { latestResultAt: new Date(T0 + 60_000) })).toBe(false);
  });

  it("drops an event once a direct run or an earlier duplicate stored a result after it was sent", () => {
    expect(eventSuperseded(T0, { latestResultAt: new Date(T0 + 180_000) })).toBe(true);
    expect(eventSuperseded(T0, { latestResultAt: iso(T0 + 180_000) })).toBe(true);
  });

  it("drops an event while a direct run that started later holds the project", () => {
    expect(eventSuperseded(T0, { progress: { ...queued, startedAt: iso(T0 + 120_000), direct: true } })).toBe(true);
    expect(eventSuperseded(T0, { progress: { ...queued, startedAt: iso(T0 - 1000), direct: true } })).toBe(false);
    expect(eventSuperseded(T0, { progress: { ...queued, startedAt: iso(T0 + 120_000) } })).toBe(false);
  });
});
