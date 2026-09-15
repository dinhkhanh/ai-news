/** A pipeline step is considered stuck after this long without a project update (docs/PLAN.md §4: any step can be re-run). */
export const BUSY_STALE_MS = 15 * 60 * 1000;

export function busyStep(p: { busyStep: string | null; updatedAt: Date }, now = Date.now()) {
  if (!p.busyStep) return null;
  return now - p.updatedAt.getTime() > BUSY_STALE_MS ? null : p.busyStep;
}

export function busyIsStale(p: { busyStep: string | null; updatedAt: Date }, now = Date.now()) {
  return Boolean(p.busyStep) && busyStep(p, now) === null;
}
