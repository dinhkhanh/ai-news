import { describe, expect, it } from "vitest";
import { commit, HISTORY_LIMIT, initHistory, redo, redoLabel, undo, undoLabel } from "./editor-history";

describe("editor history", () => {
  it("undoes and redoes labelled steps", () => {
    let h = initHistory("a");
    h = commit(h, "b", "first", { now: 0 });
    h = commit(h, "c", "second", { now: 5000 });
    expect(undoLabel(h)).toBe("second");
    h = undo(h);
    expect(h.present).toBe("b");
    expect(redoLabel(h)).toBe("second");
    h = undo(h);
    expect(h.present).toBe("a");
    expect(undo(h)).toBe(h);
    h = redo(redo(h));
    expect(h.present).toBe("c");
    expect(redo(h)).toBe(h);
  });

  it("merges quick steps with the same key and drops the redo branch on a new step", () => {
    let h = initHistory("");
    h = commit(h, "x", "typing", { coalesce: "s1.text", now: 0 });
    h = commit(h, "xy", "typing", { coalesce: "s1.text", now: 400 });
    h = commit(h, "xyz", "typing", { coalesce: "s1.text", now: 800 });
    expect(h.past).toHaveLength(1);
    // Too late to merge: a new step.
    h = commit(h, "xyz!", "typing", { coalesce: "s1.text", now: 5000 });
    expect(h.past).toHaveLength(2);
    h = undo(h);
    h = commit(h, "other", "other", { now: 6000 });
    expect(h.future).toHaveLength(0);
    expect(undo(h).present).toBe("xyz");
  });

  it("ignores no-op commits and keeps a bounded past", () => {
    let h = initHistory(0);
    expect(commit(h, 0, "same")).toBe(h);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = commit(h, i, `step ${i}`, { now: i * 10_000 });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});
