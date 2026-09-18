"use client";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { QueueRescue } from "@/components/queue-rescue";
import { ACTION_EVENT, formatElapsed, QUEUE_SLOW_MS, queuedForMs, STEP_ETA, STEP_LABEL, type ProjectStatus } from "@/lib/project-state";
import { cn } from "@/lib/utils";


const BUSY_MS = 2500;
const WATCH_MS = 10000;
const IDLE_MS = 45000;

/** Polls /api/projects/status for a set of ids; returns the latest statuses and reloads the server page when a `rev` changes. */
export function useProjectStatuses(initial: ProjectStatus[]) {
  const router = useRouter();
  const [statuses, setStatuses] = useState(initial);
  // Compared by content, not identity: <PipelineStatus> builds a fresh `[initial]` array every render,
  // and adopting on identity would set state on every render (infinite re-render loop).
  const initialKey = initial.map((s) => `${s.id}:${s.rev}`).join(",");
  const [seenKey, setSeenKey] = useState(initialKey);
  const latest = useRef(initial);
  const inFlight = useRef(false);

  // A server re-render (after an action or a refresh) is the new truth: adopt it during render, not in an effect.
  if (initialKey !== seenKey) {
    setSeenKey(initialKey);
    setStatuses(initial);
  }
  useEffect(() => {
    latest.current = statuses;
  }, [statuses]);

  const ids = initial.map((s) => s.id).join(",");
  const poll = useCallback(async () => {
    if (!ids || inFlight.current || document.visibilityState === "hidden") return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/projects/status?ids=${ids}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { projects: ProjectStatus[] };
      let changed = false;
      for (const s of json.projects) {
        const prev = latest.current.find((x) => x.id === s.id);
        if (prev && prev.rev !== s.rev) {
          changed = true;
          if (prev.step && !s.step) {
            if (s.lastError) toast.error(`${STEP_LABEL[prev.step] ?? prev.step}: ${s.lastError.slice(0, 200)}`);
            else if (!s.stale) toast.success(`${STEP_LABEL[prev.step] ?? prev.step}: xong`);
          }
        }
      }
      latest.current = json.projects;
      setStatuses(json.projects);
      if (changed) router.refresh();
    } catch {
      /* network hiccup: next tick */
    } finally {
      inFlight.current = false;
    }
  }, [ids, router]);

  const anyBusy = statuses.some((s) => s.step);
  const anyWatch = statuses.some((s) => s.watch);
  useEffect(() => {
    if (!ids) return;
    const every = anyBusy ? BUSY_MS : anyWatch ? WATCH_MS : IDLE_MS;
    const id = setInterval(poll, every);
    const onVisible = () => document.visibilityState === "visible" && poll();
    const onAction = () => {
      poll();
      setTimeout(poll, 1500);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(ACTION_EVENT, onAction);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(ACTION_EVENT, onAction);
    };
  }, [ids, anyBusy, anyWatch, poll]);

  return statuses;
}

/** Ticks once a second while something runs, for the elapsed-time readout. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Live view of the running pipeline step for one project: step name, what the
 * Inngest function is doing right now, a progress bar and the elapsed time.
 * Replaces the old "refresh the whole page every 4 s" loop: the page reloads
 * once, when the run has actually changed something.
 */
export function PipelineStatus({ initial, variant = "card", canRun = true, className }: { initial: ProjectStatus; variant?: "card" | "inline"; /** Writers get the direct-run buttons when the queue is slow. */ canRun?: boolean; className?: string }) {
  const [status] = useProjectStatuses([initial]);
  const now = useNow(Boolean(status?.step));
  if (!status) return null;
  const { step, stale, progress } = status;
  if (!step && !stale) return null;

  const stepLabel = STEP_LABEL[step ?? ""] ?? step ?? "";
  const startedAt = progress?.startedAt ? Date.parse(progress.startedAt) : NaN;
  const elapsed = Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : null;
  const pct = typeof progress?.pct === "number" ? Math.max(0, Math.min(100, progress.pct)) : null;
  // Requested, but the queue has not started it: normal for a few seconds, a queue problem after QUEUE_SLOW_MS.
  const queueSlow = Boolean(step) && (queuedForMs(progress, now) ?? 0) >= QUEUE_SLOW_MS;

  if (stale) {
    return (
      <div role="status" className={cn("space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm", className)}>
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span>
            Bước <b>{STEP_LABEL[status.staleStep ?? ""] ?? status.staleStep ?? "đang chạy"}</b> không phản hồi hơn 15 phút. Bạn có thể chạy lại bước đó.
          </span>
        </div>
        {variant === "card" && status.staleStep ? <QueueRescue projectId={status.id} step={status.staleStep} stale canRun={canRun} /> : null}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-full border bg-muted px-2 py-0.5 text-xs", className)}>
        <Loader2 className="size-3 animate-spin" />
        <span className="font-medium">{stepLabel}</span>
        {progress?.label ? <span className="text-muted-foreground">· {progress.label}</span> : null}
        {pct != null ? <span className="tabular-nums text-muted-foreground">{pct}%</span> : null}
        {elapsed ? <span className="tabular-nums text-muted-foreground" suppressHydrationWarning>{elapsed}</span> : null}
        {queueSlow ? <span className="text-amber-700 dark:text-amber-400">· hàng đợi chậm</span> : null}
      </span>
    );
  }

  return (
    <div role="status" aria-live="polite" className={cn("space-y-2 rounded-md border bg-muted/40 px-3 py-2 text-sm", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 font-medium">
          <Loader2 className="size-4 animate-spin" />
          Đang chạy: {stepLabel}
        </span>
        <span className="text-xs text-muted-foreground">
          {elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
          {elapsed && STEP_ETA[step ?? ""] ? " · " : ""}
          {STEP_ETA[step ?? ""] ?? ""}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          {pct != null ? (
            <div className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
          ) : (
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
          )}
        </div>
        {pct != null ? <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">{progress?.label ?? "Đang xếp hàng…"}</p>
      {queueSlow && step ? <QueueRescue projectId={status.id} step={step} canRun={canRun} /> : null}
    </div>
  );
}

const StatusContext = createContext<ProjectStatus[]>([]);

/**
 * Dashboard companion: one poller for every busy project on the list. Rows
 * read the live status through <LiveStep>; the list reloads when a project
 * changes state.
 */
export function ProjectsWatcher({ initial, children }: { initial: ProjectStatus[]; children: React.ReactNode }) {
  const statuses = useProjectStatuses(initial);
  return <StatusContext.Provider value={statuses}>{children}</StatusContext.Provider>;
}

/** Inline live status for one project inside a <ProjectsWatcher>; renders `children` when the project is idle. */
export function LiveStep({ id, children }: { id: string; children: React.ReactNode }) {
  const status = useContext(StatusContext).find((s) => s.id === id);
  const now = useNow(Boolean(status?.step));
  if (!status?.step) return <>{children}</>;
  const pct = typeof status.progress?.pct === "number" ? Math.round(status.progress.pct) : null;
  const startedAt = status.progress?.startedAt ? Date.parse(status.progress.startedAt) : NaN;
  return (
    <span className="inline-flex max-w-xs flex-col gap-0.5 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Loader2 className="size-3 animate-spin" />
        {STEP_LABEL[status.step] ?? status.step}
        {pct != null ? <span className="tabular-nums text-muted-foreground">{pct}%</span> : null}
        {Number.isFinite(startedAt) ? <span className="tabular-nums text-muted-foreground" suppressHydrationWarning>{formatElapsed(now - startedAt)}</span> : null}
      </span>
      {status.progress?.label ? <span className="truncate text-muted-foreground">{status.progress.label}</span> : null}
      {(queuedForMs(status.progress, now) ?? 0) >= QUEUE_SLOW_MS ? <span className="text-amber-700 dark:text-amber-400">Hàng đợi chậm: mở dự án để chạy trực tiếp</span> : null}
    </span>
  );
}
