import { describe, expect, it } from "vitest";
import { pickVoice, ttsCostUsd, voiceFits, type VoiceRow } from "./voices";

const rows: VoiceRow[] = [
  { id: "p-vi", organizationId: null, language: "vi", model: null, isDefault: true },
  { id: "p-en", organizationId: null, language: "en", model: null, isDefault: true },
  { id: "p-vi2", organizationId: null, language: "vi", model: null, isDefault: false },
  { id: "w-gem", organizationId: "org", language: "vi", model: "gemini-2.5-flash-tts", isDefault: false },
  { id: "w-def", organizationId: "org", language: "vi", model: "gemini-2.5-flash-tts", isDefault: true },
  { id: "other", organizationId: "org2", language: "vi", model: "gemini-2.5-flash-tts", isDefault: false },
];

describe("pickVoice", () => {
  it("uses the project's voice when it fits the language", () => {
    expect(pickVoice(rows, "vi", "p-vi2", "org")?.id).toBe("p-vi2");
    expect(pickVoice(rows, "en", "w-gem", "org")?.id).toBe("w-gem"); // Gemini voices speak both languages
  });
  it("falls back to the workspace default, then the platform default", () => {
    expect(pickVoice(rows, "vi", null, "org")?.id).toBe("w-def");
    expect(pickVoice(rows, "en", "p-vi2", "org")?.id).toBe("w-def"); // classic vi voice cannot read English
    expect(pickVoice(rows, "vi", null, "org3")?.id).toBe("p-vi");
    expect(pickVoice(rows, "en", null, "org3")?.id).toBe("p-en");
  });
  it("never takes another workspace's voice", () => {
    expect(pickVoice(rows, "vi", "other", "org3")?.id).toBe("p-vi");
  });
});

describe("voiceFits / ttsCostUsd", () => {
  it("classic voices keep to their language", () => {
    expect(voiceFits({ language: "vi", model: null }, "en")).toBe(false);
    expect(voiceFits({ language: "vi", model: "gemini-2.5-flash-tts" }, "en")).toBe(true);
  });
  it("prices Gemini by audio seconds and classic voices by characters", () => {
    expect(ttsCostUsd({ voice: "Kore", model: "gemini-2.5-flash-tts", chars: 0, durationMs: 60_000 })).toBeCloseTo(0.015, 6);
    expect(ttsCostUsd({ voice: "vi-VN-Chirp3-HD-Fenrir", model: null, chars: 1000, durationMs: 0 })).toBeCloseTo(0.03, 6);
  });
});
