import { describe, expect, it } from "vitest";
import {
  audioContentType,
  canEditCollection,
  canManageCollection,
  canSeeCollection,
  collectionName,
  formatDuration,
  isAllowedAudioUrl,
  keepResult,
  licenceInfo,
  openverseDetailUrl,
  openverseSearchUrl,
  parseOpenverseAudio,
  parseSoundSearch,
  pixabayMusicPage,
  pixabaySearchUrl,
  sniffAudio,
  soundCredit,
  titleFromPixabayPage,
} from "./sound-library";

// Trimmed from a real api.openverse.org/v1/audio/ response.
const freesound = {
  id: "6b072076-066b-45b6-9695-367a6260c96d",
  title: "Rain, Moderate, C.wav",
  foreign_landing_url: "https://freesound.org/people/InspectorJ/sounds/401275",
  url: "https://cdn.freesound.org/previews/401/401275_5121236-hq.mp3",
  creator: "InspectorJ",
  creator_url: "https://freesound.org/people/InspectorJ",
  license: "by",
  license_version: "4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  provider: "freesound",
  source: "freesound",
  category: null,
  tags: [{ name: "Rain" }, { name: "rain" }, { name: "weather" }],
  mature: false,
  duration: 60116,
};
const jamendo = {
  id: "bc979f17-b065-47be-b505-18ed3d092aec",
  title: "New Trend",
  foreign_landing_url: "https://www.jamendo.com/track/1187965",
  url: "https://prod-1.storage.jamendo.com/?trackid=1187965&format=mp32",
  creator: "Anny Sky",
  license: "by-sa",
  license_version: "3.0",
  source: "jamendo",
  category: "music",
  duration: 211000,
};

describe("parseOpenverseAudio", () => {
  it("normalises a Freesound item", () => {
    const r = parseOpenverseAudio(freesound)!;
    expect(r).toMatchObject({ providerId: freesound.id, title: "Rain, Moderate, C", creator: "InspectorJ", source: "freesound", sourceLabel: "Freesound", licence: "by", licenceVersion: "4.0", kind: "sfx", durationSec: 60.1 });
    expect(r.tags).toEqual(["rain", "weather"]);
  });
  it("reads a Jamendo music item", () => {
    expect(parseOpenverseAudio(jamendo)).toMatchObject({ kind: "music", sourceLabel: "Jamendo", durationSec: 211, licence: "by-sa" });
  });
  it("drops items without a playable URL, a licence, or marked mature", () => {
    expect(parseOpenverseAudio({ ...jamendo, url: "javascript:alert(1)" })).toBeNull();
    expect(parseOpenverseAudio({ ...jamendo, license: "" })).toBeNull();
    expect(parseOpenverseAudio({ ...jamendo, mature: true })).toBeNull();
    expect(parseOpenverseAudio(null)).toBeNull();
  });
});

describe("licenceInfo", () => {
  it("tells monetised channels what they may use", () => {
    expect(licenceInfo("cc0")).toMatchObject({ label: "CC0", commercial: true, attributionRequired: false });
    expect(licenceInfo("by", "4.0")).toMatchObject({ label: "CC BY 4.0", commercial: true, attributionRequired: true });
    expect(licenceInfo("by-sa", "3.0")).toMatchObject({ commercial: true, shareAlike: true });
    expect(licenceInfo("by-nc", "4.0")).toMatchObject({ commercial: false, tone: "restricted" });
    expect(licenceInfo("by-nd")).toMatchObject({ tone: "restricted" });
    expect(licenceInfo("sampling+").commercial).toBe(false);
    expect(licenceInfo("pixabay")).toMatchObject({ label: "Pixabay", commercial: true, attributionRequired: false });
  });
  it("keeps ND and NC out of a commercial-only search", () => {
    const r = parseOpenverseAudio(jamendo)!;
    expect(keepResult(r, true)).toBe(true);
    expect(keepResult({ ...r, licence: "by-nd" }, true)).toBe(false);
    expect(keepResult({ ...r, licence: "by-nc" }, true)).toBe(false);
    expect(keepResult({ ...r, licence: "by-nc" }, false)).toBe(true);
  });
});

describe("search URLs", () => {
  it("cleans client input", () => {
    const f = parseSoundSearch({ q: "  rain   storm ", kind: "nope", sources: ["jamendo", "evil", "jamendo"], lengths: ["short", "x"], page: 99 });
    expect(f).toEqual({ q: "rain storm", kind: "all", sources: ["jamendo"], commercialOnly: true, lengths: ["short"], page: 12 });
    expect(parseSoundSearch({}).sources).toEqual(["jamendo", "freesound", "wikimedia_audio"]);
  });
  it("maps the filters to Openverse parameters", () => {
    const music = new URL(openverseSearchUrl(parseSoundSearch({ q: "news", kind: "music", lengths: ["medium"] })));
    expect(music.pathname).toBe("/v1/audio/");
    expect(Object.fromEntries(music.searchParams)).toMatchObject({ q: "news", category: "music", license_type: "commercial", length: "medium", page: "1", page_size: "20" });
    expect(music.searchParams.has("source")).toBe(false);
    // Effects = Freesound (no categories there), not a category filter that would drop it.
    const sfx = new URL(openverseSearchUrl(parseSoundSearch({ q: "whoosh", kind: "sfx", commercialOnly: false })));
    expect(sfx.searchParams.get("source")).toBe("freesound");
    expect(sfx.searchParams.has("category")).toBe(false);
    expect(sfx.searchParams.get("license_type")).toBe("all-cc");
    const sfxNoFreesound = new URL(openverseSearchUrl(parseSoundSearch({ q: "bell", kind: "sfx", sources: ["wikimedia_audio"] })));
    expect(sfxNoFreesound.searchParams.get("category")).toBe("sound_effect");
    expect(sfxNoFreesound.searchParams.get("source")).toBe("wikimedia_audio");
  });
  it("downloads audio only from the Openverse sources' hosts", () => {
    expect(isAllowedAudioUrl(freesound.url)).toBe(true);
    expect(isAllowedAudioUrl(jamendo.url)).toBe(true);
    expect(isAllowedAudioUrl("https://upload.wikimedia.org/wikipedia/commons/a/a1/Rain.ogg")).toBe(true);
    expect(isAllowedAudioUrl("http://cdn.freesound.org/x.mp3")).toBe(false);
    expect(isAllowedAudioUrl("https://freesound.org.evil.example/x.mp3")).toBe(false);
    expect(isAllowedAudioUrl("https://169.254.169.254/latest")).toBe(false);
  });
  it("only builds detail URLs for UUIDs", () => {
    expect(openverseDetailUrl(jamendo.id)).toBe(`https://api.openverse.org/v1/audio/${jamendo.id}/`);
    expect(openverseDetailUrl("../../admin")).toBeNull();
  });
});

describe("Pixabay", () => {
  it("links to its music search", () => {
    expect(pixabaySearchUrl("  news  intro ")).toBe("https://pixabay.com/music/search/news%20intro/");
    expect(pixabaySearchUrl("")).toBe("https://pixabay.com/music/");
  });
  it("accepts only track pages", () => {
    expect(pixabayMusicPage("https://pixabay.com/vi/music/beats-corporate-news-123456/?utm=x")).toBe("https://pixabay.com/music/beats-corporate-news-123456/");
    expect(pixabayMusicPage("https://pixabay.com/sound-effects/whoosh-6316/")).toBe("https://pixabay.com/sound-effects/whoosh-6316/");
    expect(pixabayMusicPage("https://pixabay.com/photos/rose-123/")).toBeNull();
    expect(pixabayMusicPage("https://evil.example/music/x-1/")).toBeNull();
    expect(titleFromPixabayPage("https://pixabay.com/music/beats-corporate-news-123456/")).toBe("Beats corporate news");
  });
});

describe("credits and access", () => {
  it("writes the credit line", () => {
    expect(soundCredit({ title: "New Trend", creator: "Anny Sky", sourceLabel: "Jamendo", licence: "by-sa", licenceVersion: "3.0" })).toBe("Nhạc: “New Trend” – Anny Sky (Jamendo), CC BY-SA 3.0");
    expect(soundCredit({ title: "Whoosh", creator: null, sourceLabel: "Pixabay", licence: "pixabay", licenceVersion: null }, "sfx")).toBe("Âm thanh: “Whoosh” (Pixabay), Pixabay Content License");
    expect(soundCredit({ title: "Jingle", creator: "Toà soạn", sourceLabel: "Tệp tải lên", licence: "own", licenceVersion: null })).toBe("Nhạc: “Jingle” – Toà soạn (Tệp tải lên)");
  });
  it("gates private and shared collections", () => {
    const me = { userId: "u1", canWrite: true, canManageWorkspace: false };
    const admin = { userId: "u2", canWrite: true, canManageWorkspace: true };
    const reader = { userId: "u3", canWrite: false, canManageWorkspace: false };
    const mine = { createdBy: "u1", shared: false };
    const shared = { createdBy: "u1", shared: true };
    expect(canSeeCollection(mine, admin)).toBe(false);
    expect(canSeeCollection(shared, reader)).toBe(true);
    expect(canEditCollection(mine, me)).toBe(true);
    expect(canEditCollection(shared, admin)).toBe(true);
    expect(canEditCollection(shared, reader)).toBe(false);
    expect(canManageCollection(shared, admin)).toBe(true);
    expect(canManageCollection(mine, admin)).toBe(false);
    expect(canManageCollection(shared, { ...me, userId: "u4" })).toBe(false);
  });
  it("names and file types", () => {
    expect(collectionName("  Tin   nóng ")).toBe("Tin nóng");
    expect(audioContentType("a.mp3", "")).toBe("audio/mpeg");
    expect(audioContentType("a.m4a", "video/mp4")).toBe("audio/mp4");
    expect(audioContentType("x", "audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(audioContentType("a.exe", "application/octet-stream")).toBeNull();
    expect(formatDuration(65.4)).toBe("1:05");
    const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    expect(sniffAudio(bytes("ID3\u0004"))).toBe("audio/mpeg");
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90]))).toBe("audio/mpeg");
    expect(sniffAudio(bytes("RIFF\u0000\u0000\u0000\u0000WAVEfmt "))).toBe("audio/wav");
    expect(sniffAudio(bytes("OggS\u0000"))).toBe("audio/ogg");
    expect(sniffAudio(bytes("\u0000\u0000\u0000\u0018ftypM4A "))).toBe("audio/mp4");
    expect(sniffAudio(bytes("<html>"))).toBeNull();
  });
});
