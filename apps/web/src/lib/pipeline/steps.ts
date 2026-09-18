/**
 * The slice of Inngest's `step` the pipeline bodies use. Under Inngest every `run` is a durable, memoised,
 * retried step; `directSteps` simply calls through, for a direct run inside a server action when the queue
 * is down (no retries, no checkpoints: a failure is reported straight to the project).
 * Step callbacks must return JSON-safe values, because that is what Inngest hands back on a replay.
 */
export type PipelineSteps = {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
};

export const directSteps: PipelineSteps = {
  run: async (_id, fn) => fn(),
};

/**
 * Inngest's `step` as `PipelineSteps`. Inngest types a step's result as its JSON form (`Jsonify<T>`), which no
 * generic signature can promise; the bodies return JSON-safe values only (see above), so the two agree at runtime.
 */
export const durableSteps = (step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> }): PipelineSteps => ({
  run: <T>(id: string, fn: () => Promise<T> | T) => step.run(id, async () => fn()) as Promise<T>,
});
