import { describe, expect, it } from "vitest";
import { parseBlackDetect, parseFps, parseLoudnormJson } from "./ffmpeg";

describe("ffmpeg output parsers", () => {
  it("parses loudnorm json from stderr tail", () => {
    const stderr = `noise\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-23.10",\n\t"input_tp" : "-4.20"\n}\n`;
    expect(parseLoudnormJson(stderr)).toEqual({ input_i: "-23.10", input_tp: "-4.20" });
  });
  it("parses blackdetect lines", () => {
    const stderr = "[blackdetect @ 0x1] black_start:0 black_end:0.5 black_duration:0.5\n[blackdetect @ 0x1] black_start:3.1 black_end:3.4 black_duration:0.3";
    expect(parseBlackDetect(stderr)).toEqual([
      { start: 0, end: 0.5 },
      { start: 3.1, end: 3.4 },
    ]);
  });
  it("parses r_frame_rate", () => {
    expect(parseFps("30/1")).toBe(30);
    expect(parseFps("30000/1001")).toBe(29.97);
    expect(parseFps(undefined)).toBe(0);
  });
});
