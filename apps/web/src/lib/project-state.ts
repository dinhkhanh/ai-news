/** A pipeline step is considered stuck after this long without a project update (docs/PLAN.md §4: any step can be re-run). */
export const BUSY_STALE_MS = 15 * 60 * 1000;

/**
 * The queue (Inngest) normally picks a step up within seconds. A step still waiting after this long means the
 * queue is slow or down: the page says so and offers to run short steps directly (src/lib/pipeline/direct.ts).
 */
export const QUEUE_SLOW_MS = 90 * 1000;

/** Steps short enough to run inside the app when the queue does not pick them up. */
export const DIRECT_STEPS = ["fetch", "script"] as const;
export type DirectStep = (typeof DIRECT_STEPS)[number];

/** `projects.inngest_run_id` after a failed direct fetch: the page then offers the direct re-fetch buttons as well. Cleared by the next stored article. */
export const DIRECT_RUN_ID = "direct";

/** What a project is called in lists and headings: its title, else its link, else (content typed in, not stored yet) a placeholder. */
export const projectLabel = (p: { title: string | null; url: string | null }) => p.title ?? p.url ?? "Nội dung tự nhập";

/** Fired by <ActionForm> after a successful submit so watchers re-poll at once instead of waiting for the next tick. */
export const ACTION_EVENT = "ai-news:action";

/** Live progress of the running step (projects.busy_progress), merged by src/lib/progress.ts. */
export type BusyProgress = {
  /** When the step was queued (set by the server action / auto mode). */
  startedAt?: string;
  /** Last update. */
  at?: string;
  /** What is happening right now, in the UI language. */
  label?: string;
  /** 0–100, or null when the step cannot estimate. */
  pct?: number | null;
  /** Counter for parallel work ("Giọng đọc 3/8"). */
  done?: number;
  total?: number;
  /** The step runs inside the app (a direct run), not in the queue. */
  direct?: boolean;
};

export type PipelineStep = "fetch" | "script" | "assets" | "render" | "regenerate";

export const STEP_LABEL: Record<string, string> = {
  fetch: "Lấy bài báo",
  script: "Viết kịch bản",
  assets: "Dựng video",
  render: "Kết xuất",
  regenerate: "Tạo lại",
};

export const STEP_ETA: Record<string, string> = {
  fetch: "thường 10–40 giây",
  script: "thường 1–3 phút",
  assets: "thường 2–4 phút",
  render: "thường 1–3 phút",
  regenerate: "thường 30–90 giây",
};

/** What the page shows while polling: everything the client needs to render progress and to know when to reload. */
export type ProjectStatus = {
  id: string;
  state: string;
  /** Running step, or null when idle or stale. */
  step: string | null;
  /** busy_step is set but nothing has touched the project for BUSY_STALE_MS. */
  stale: boolean;
  /** The step that went quiet, when `stale`. */
  staleStep: string | null;
  progress: BusyProgress | null;
  lastError: string | null;
  /** Something asynchronous is still going (a pipeline step or a publication in flight). */
  watch: boolean;
  /** Changes whenever the page content would differ; the client reloads the server page when it does. */
  rev: string;
  updatedAt: string;
};

export function busyStep(p: { busyStep: string | null; updatedAt: Date }, now = Date.now()) {
  if (!p.busyStep) return null;
  return now - p.updatedAt.getTime() > BUSY_STALE_MS ? null : p.busyStep;
}

export function busyIsStale(p: { busyStep: string | null; updatedAt: Date }, now = Date.now()) {
  return Boolean(p.busyStep) && busyStep(p, now) === null;
}

/**
 * How long a step has been waiting for the queue, or null once something runs it: `startProgress` writes
 * `at` = `startedAt`, and the first `reportProgress` of the function moves `at` on.
 */
export function queuedForMs(progress: BusyProgress | null | undefined, now = Date.now()) {
  if (!progress?.startedAt || progress.direct || progress.at !== progress.startedAt) return null;
  const startedAt = Date.parse(progress.startedAt);
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null;
}

/** A requested step may be taken over by a direct run when the queue never started it, or when it went quiet. */
export function directRunAllowed(p: { busyStep: string | null; busyProgress: BusyProgress | null; updatedAt: Date }, step: DirectStep, now = Date.now()) {
  if (p.busyStep !== step) return false;
  if (busyIsStale(p, now)) return true;
  const waited = queuedForMs(p.busyProgress, now);
  return waited != null && waited >= QUEUE_SLOW_MS;
}

/**
 * A queued event is obsolete when the step it asks for produced a result after the event was sent (a direct
 * run, or an earlier duplicate that drained first), or when a direct run started later still holds the project.
 * Checked in the first step of every pipeline function, so a backlog that drains after an outage redoes nothing.
 */
export function eventSuperseded(eventTs: number | undefined, p: { latestResultAt?: Date | string | null; progress?: BusyProgress | null }) {
  if (!eventTs) return false;
  const resultAt = p.latestResultAt ? new Date(p.latestResultAt).getTime() : NaN;
  if (Number.isFinite(resultAt) && resultAt > eventTs) return true;
  const directAt = p.progress?.direct && p.progress.startedAt ? Date.parse(p.progress.startedAt) : NaN;
  return Number.isFinite(directAt) && directAt > eventTs;
}

/** Progress value written when a step is queued, before the Inngest function reports anything. */
export function startProgress(label = "Đang xếp hàng…"): BusyProgress {
  const now = new Date().toISOString();
  return { startedAt: now, at: now, label, pct: 0 };
}

export type StatusInput = {
  project: { id: string; state: string; busyStep: string | null; busyProgress: BusyProgress | null; lastError: string | null; updatedAt: Date; approvedTimelineId: string | null; title: string | null };
  latestScriptVersion: number;
  latestTimelineVersion: number;
  renders: { total: number; active: number };
  publications: { total: number; active: number };
};

/** Pure: the same shape from a page's already-loaded rows or from the status API, so both agree on `rev`. */
export function buildStatus(input: StatusInput, now = Date.now()): ProjectStatus {
  const { project } = input;
  const step = busyStep(project, now);
  const stale = busyIsStale(project, now);
  const watch = Boolean(step) || input.publications.active > 0 || input.renders.active > 0;
  const rev = [
    project.state,
    step ?? "",
    stale ? "stale" : "",
    project.lastError ? project.lastError.length : 0,
    project.approvedTimelineId ?? "",
    project.title ?? "",
    input.latestScriptVersion,
    input.latestTimelineVersion,
    `${input.renders.total}:${input.renders.active}`,
    `${input.publications.total}:${input.publications.active}`,
  ].join("|");
  return {
    id: project.id,
    state: project.state,
    step,
    stale,
    staleStep: stale ? project.busyStep : null,
    progress: step || stale ? (project.busyProgress ?? null) : null,
    lastError: project.lastError,
    watch,
    rev,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
