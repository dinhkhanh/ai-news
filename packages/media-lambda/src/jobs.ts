import { randomUUID } from "node:crypto";
import type { MediaAction, MediaResult } from "./types.js";

/**
 * Background downloads for the self-hosted API (`server.ts`). A section download plus its encode can take
 * minutes on a NAS CPU, longer than a reverse proxy (DSM: 60 s) or the app's serverless functions (300 s)
 * hold a request open, so the app starts a job and asks for its state until it is done.
 *
 * - The same video section asked for again while its job is queued, running or recently done gets that job
 *   back instead of a second download: an app retry re-attaches rather than piling work onto the NAS.
 * - At most `maxConcurrent` jobs run; the rest wait in order.
 * - Finished jobs are kept for `keepMs` so a late poll still gets the result.
 */
export type WebVideoAction = Extract<MediaAction, { action: "web-video" }>;
export type JobState = "queued" | "running" | "done";
export type JobView = { jobId: string; state: JobState; result?: MediaResult; queuedAhead?: number; startedAt?: number; finishedAt?: number };

type Job = { id: string; key: string; event: WebVideoAction; state: JobState; result?: MediaResult; createdAt: number; startedAt?: number; finishedAt?: number };

/** Two requests for the same section of the same page are one job. */
export const jobKey = (e: WebVideoAction) => `${e.input.url}|${e.trim?.startSec ?? 0}|${e.trim?.endSec ?? ""}`;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private running = 0;

  constructor(
    private run: (event: WebVideoAction) => Promise<MediaResult>,
    private opts: { maxConcurrent: number; keepMs: number; now?: () => number; onFinish?: (job: { event: WebVideoAction; result: MediaResult; ms: number }) => void },
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Start a download, or return the job already doing (or done with) the same section. A failed job is not reused. */
  submit(event: WebVideoAction): JobView {
    this.prune();
    const key = jobKey(event);
    for (const j of this.jobs.values()) if (j.key === key && (j.state !== "done" || j.result?.ok)) return this.view(j);
    const job: Job = { id: randomUUID(), key, event, state: "queued", createdAt: this.now() };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.pump();
    return this.view(job);
  }

  get(id: string): JobView | null {
    this.prune();
    const j = this.jobs.get(id);
    return j ? this.view(j) : null;
  }

  /** Jobs running / waiting, for `/health`. */
  stats() {
    let queued = 0;
    for (const j of this.jobs.values()) if (j.state === "queued") queued += 1;
    return { running: this.running, queued };
  }

  private view(j: Job): JobView {
    const ahead = j.state === "queued" ? this.order.indexOf(j.id) : undefined;
    return { jobId: j.id, state: j.state, ...(j.result ? { result: j.result } : {}), ...(ahead !== undefined && ahead >= 0 ? { queuedAhead: ahead } : {}), ...(j.startedAt ? { startedAt: j.startedAt } : {}), ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}) };
  }

  private pump() {
    while (this.running < this.opts.maxConcurrent && this.order.length) {
      const job = this.jobs.get(this.order.shift()!);
      if (!job) continue;
      this.running += 1;
      job.state = "running";
      job.startedAt = this.now();
      void this.run(job.event)
        .catch((e: unknown): MediaResult => ({ ok: false, action: "web-video", passed: false, error: e instanceof Error ? e.message : String(e) }))
        .then((result) => {
          job.state = "done";
          job.result = result;
          job.finishedAt = this.now();
          this.running -= 1;
          this.opts.onFinish?.({ event: job.event, result, ms: job.finishedAt - (job.startedAt ?? job.finishedAt) });
          this.pump();
        });
    }
  }

  private prune() {
    const cutoff = this.now() - this.opts.keepMs;
    for (const [id, j] of this.jobs) if (j.state === "done" && (j.finishedAt ?? 0) < cutoff) this.jobs.delete(id);
  }
}
