/**
 * Undo / redo for the editor document (pure, tested). Every change is a labelled step
 * ("s3: sửa chữ trên màn hình"); steps with the same `coalesce` key made within
 * `COALESCE_MS` of each other merge, so typing a line is one undo step, not one per key.
 */
export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1200;

export type HistoryEntry<T> = { value: T; label: string };
export type History<T> = {
  /** States before each step, oldest first; `label` names the step that left it. */
  past: HistoryEntry<T>[];
  present: T;
  /** States undone, next redo first; `label` names the step that leads to it. */
  future: HistoryEntry<T>[];
  lastKey: string | null;
  lastAt: number;
};

export function initHistory<T>(value: T): History<T> {
  return { past: [], present: value, future: [], lastKey: null, lastAt: 0 };
}

/** Record `next` as a new step (no-op when it is the same object). */
export function commit<T>(h: History<T>, next: T, label: string, opts: { coalesce?: string | null; now?: number } = {}): History<T> {
  if (next === h.present) return h;
  const now = opts.now ?? Date.now();
  const key = opts.coalesce ?? null;
  if (key && key === h.lastKey && now - h.lastAt < COALESCE_MS && h.past.length) return { ...h, present: next, future: [], lastAt: now };
  const past = [...h.past, { value: h.present, label }].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past.at(-1);
  if (!prev) return h;
  return { past: h.past.slice(0, -1), present: prev.value, future: [{ value: h.present, label: prev.label }, ...h.future], lastKey: null, lastAt: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (!next) return h;
  return { past: [...h.past, { value: h.present, label: next.label }].slice(-HISTORY_LIMIT), present: next.value, future: h.future.slice(1), lastKey: null, lastAt: 0 };
}

/** Label of the step `undo` would revert / `redo` would replay, for tooltips. */
export const undoLabel = <T>(h: History<T>) => h.past.at(-1)?.label ?? null;
export const redoLabel = <T>(h: History<T>) => h.future[0]?.label ?? null;
