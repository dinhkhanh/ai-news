import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Next renders a page segment without its layout when the request says the layout is already
 * mounted, so the requireAdmin() in admin/layout.tsx does not protect the pages below it.
 */
function files(dir: string, name: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name), name) : name.test(e.name) ? [path.join(dir, e.name)] : [],
  );
}

describe("admin area", () => {
  it("checks the admin role in every page, not only in the layout", () => {
    const pages = files(__dirname, /^page\.tsx$/);
    expect(pages.length).toBeGreaterThanOrEqual(13);
    for (const f of pages) expect(readFileSync(f, "utf8"), path.relative(__dirname, f)).toMatch(/^\s*await requireAdmin\(\);$/m);
  });

  it("checks the admin role in every exported server action", () => {
    for (const f of files(__dirname, /^actions\.ts$/)) {
      const src = readFileSync(f, "utf8");
      const actions = src.split(/^export async function /m).slice(1);
      expect(actions.length, path.relative(__dirname, f)).toBeGreaterThan(0);
      for (const a of actions) expect(a, `${path.relative(__dirname, f)}: ${a.slice(0, 40)}`).toMatch(/assertAdmin\(/);
    }
  });
});
