import { describe, expect, it } from "vitest";
import { formatColour, normaliseColour, parseColour } from "./colour";

describe("brand colours", () => {
  it("parses hex with and without alpha, short forms included", () => {
    expect(parseColour("#0F172A")).toEqual({ hex: "#0f172a", alpha: 1 });
    expect(parseColour("#0f172a80")).toEqual({ hex: "#0f172a", alpha: 0.5 });
    expect(parseColour("#fa08")).toEqual({ hex: "#ffaa00", alpha: 0.53 });
  });

  it("reads the rgba() values older kits hold", () => {
    expect(normaliseColour("rgba(0,0,0,0.72)")).toBe("#000000b8");
    expect(normaliseColour("rgb(255 128 0 / 50%)")).toBe("#ff800080");
    expect(normaliseColour("rgb(15, 23, 42)")).toBe("#0f172a");
  });

  it("writes six digits when opaque and eight otherwise, and survives a round trip", () => {
    expect(formatColour({ hex: "#F59E0B", alpha: 1 })).toBe("#f59e0b");
    expect(formatColour({ hex: "#f59e0b", alpha: 0 })).toBe("#f59e0b00");
    for (const a of [0, 0.1, 0.25, 0.72, 0.99]) expect(parseColour(formatColour({ hex: "#123456", alpha: a }))!.alpha).toBeCloseTo(a, 2);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "red", "#12", "#12345", "rgb(300,0,0)", "url(x)", "#0f172a; background:url(x)"]) expect(parseColour(bad)).toBeNull();
  });
});
