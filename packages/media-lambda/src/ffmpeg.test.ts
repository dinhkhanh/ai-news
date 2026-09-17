import { describe, expect, it } from "vitest";
import { parseBlackDetect, parseFps, parseLoudnormJson, ytdlpError } from "./ffmpeg";

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

describe("parseLoudnormJson with ffmpeg 7+/8 trailing summary", () => {
  it("stops at the closing brace and tolerates -inf on silent input", () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-16.79",\n\t"input_tp" : "-2.89",\n\t"target_offset" : "0.05"\n}\n[out#0/null @ 0x2] video:0KiB audio:7500KiB\nsize=N/A time=00:00:10.00 bitrate=N/A speed=34.5x elapsed=0:00:00.28\n`;
    expect(parseLoudnormJson(stderr)?.input_i).toBe("-16.79");
    const silent = `{\n\t"input_i" : -inf,\n\t"input_tp" : -inf,\n\t"target_offset" : "inf"\n}\n[out#0/null @ 0x2] video:0KiB\n`;
    expect(parseLoudnormJson(silent)?.input_i).toBe("-inf");
  });
  it("extracts the yt-dlp error line instead of the command line", () => {
    expect(ytdlpError({ message: "Command failed: yt-dlp ...", stderr: "WARNING: x\nERROR: [youtube] abc: Sign in to confirm you’re not a bot\n" })).toBe("ERROR: [youtube] abc: Sign in to confirm you’re not a bot");
    expect(ytdlpError({ message: "Command failed", stderr: "Traceback\nImportError: unsupported version of Python\n" })).toBe("ImportError: unsupported version of Python");
    expect(ytdlpError(new Error("spawn ENOENT"))).toBe("spawn ENOENT");
  });
});
