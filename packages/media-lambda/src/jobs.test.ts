import { describe, expect, it } from "vitest";
import { JobQueue, type WebVideoAction } from "./jobs";
import type { MediaResult } from "./types";

const action = (url: string, startSec = 0, endSec = 120): WebVideoAction => ({ action: "web-video", input: { url }, output: { key: `tmp/smoke/${startSec}.mp4` }, trim: { startSec, endSec } });

/** A runner whose downloads finish when the test says so. */
function controlled() {
  const pending: Array<{ url: string; resolve: (r: MediaResult) => void; reject: (e: Error) => void }> = [];
  const run = (e: WebVideoAction) => new Promise<MediaResult>((resolve, reject) => pending.push({ url: e.input.url, resolve, reject }));
  const ok = (key = "k.mp4"): MediaResult => ({ ok: true, action: "web-video", passed: true, outputKey: key });
  return { pending, run, ok };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("JobQueue", () => {
  it("runs a job in the background and reports its result", async () => {
    const c = controlled();
    const q = new JobQueue(c.run, { maxConcurrent: 2, keepMs: 60_000 });
    const j = q.submit(action("https://www.facebook.com/reel/1"));
    expect(q.get(j.jobId)?.state).toBe("running");
    c.pending[0].resolve(c.ok());
    await tick();
    expect(q.get(j.jobId)).toMatchObject({ state: "done", result: { ok: true, outputKey: "k.mp4" } });
  });

  it("gives a retry of the same section the job already running, not a second download", async () => {
    const c = controlled();
    const q = new JobQueue(c.run, { maxConcurrent: 2, keepMs: 60_000 });
    const a = q.submit(action("https://www.facebook.com/reel/1"));
    const b = q.submit({ ...action("https://www.facebook.com/reel/1"), output: { key: "tmp/smoke/other.mp4" } });
    expect(b.jobId).toBe(a.jobId);
    expect(c.pending).toHaveLength(1);
    // A different section is a different job.
    expect(q.submit(action("https://www.facebook.com/reel/1", 10, 20)).jobId).not.toBe(a.jobId);
  });

  it("queues past the concurrency limit and starts the next job when one finishes", async () => {
    const c = controlled();
    const q = new JobQueue(c.run, { maxConcurrent: 1, keepMs: 60_000 });
    q.submit(action("https://www.facebook.com/reel/1"));
    const second = q.submit(action("https://www.facebook.com/reel/2"));
    expect(q.get(second.jobId)).toMatchObject({ state: "queued", queuedAhead: 0 });
    expect(q.stats()).toEqual({ running: 1, queued: 1 });
    c.pending[0].resolve(c.ok());
    await tick();
    expect(q.get(second.jobId)?.state).toBe("running");
    expect(c.pending.map((p) => p.url)).toEqual(["https://www.facebook.com/reel/1", "https://www.facebook.com/reel/2"]);
  });

  it("reports a failed download and lets the next request try again", async () => {
    const c = controlled();
    const q = new JobQueue(c.run, { maxConcurrent: 1, keepMs: 60_000 });
    const a = q.submit(action("https://www.facebook.com/reel/1"));
    c.pending[0].reject(new Error("yt-dlp: boom"));
    await tick();
    expect(q.get(a.jobId)).toMatchObject({ state: "done", result: { ok: false, error: "yt-dlp: boom" } });
    expect(q.submit(action("https://www.facebook.com/reel/1")).jobId).not.toBe(a.jobId);
  });

  it("forgets finished jobs after the retention window", async () => {
    let now = 1_000;
    const c = controlled();
    const q = new JobQueue(c.run, { maxConcurrent: 1, keepMs: 10_000, now: () => now });
    const a = q.submit(action("https://www.facebook.com/reel/1"));
    c.pending[0].resolve(c.ok());
    await tick();
    now += 5_000;
    expect(q.get(a.jobId)?.state).toBe("done");
    now += 10_000;
    expect(q.get(a.jobId)).toBeNull();
  });
});
