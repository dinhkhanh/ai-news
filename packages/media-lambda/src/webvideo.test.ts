import { describe, expect, it } from "vitest";
import { dedupeCandidates, parseSearchJson, toCandidate } from "./webvideo";

describe("yt-dlp search parsing", () => {
  it("maps flat ytsearch entries to candidates and skips lives", () => {
    const stdout = JSON.stringify({
      _type: "playlist",
      entries: [
        { id: "abc", url: "https://www.youtube.com/watch?v=abc", title: "Bão số 3 đổ bộ", duration: 95, ie_key: "Youtube", channel: "VTV24", view_count: 1200, thumbnails: [{ url: "s.jpg", width: 120 }, { url: "l.jpg", width: 1280 }] },
        { id: "live", url: "https://www.youtube.com/watch?v=live", title: "LIVE", duration: null, ie_key: "Youtube", live_status: "is_live" },
        { _type: "playlist", id: "pl", url: "https://www.youtube.com/playlist?list=1" },
      ],
    });
    expect(parseSearchJson(`WARNING: foo\n${stdout}`)).toEqual([
      { id: "abc", url: "https://www.youtube.com/watch?v=abc", title: "Bão số 3 đổ bộ", site: "YouTube", durationSec: 95, thumbnailUrl: "l.jpg", uploader: "VTV24", viewCount: 1200, uploadDate: null, width: null, height: null },
    ]);
  });

  it("maps a full single-video dump (TikTok) with dimensions", () => {
    const c = toCandidate({ id: "7", webpage_url: "https://www.tiktok.com/@x/video/7", title: "t", duration: 21.4, extractor_key: "TikTok", uploader: "x", width: 1080, height: 1920, thumbnail: "th.jpg", upload_date: "20260915" });
    expect(c).toMatchObject({ site: "TikTok", durationSec: 21.4, width: 1080, height: 1920, thumbnailUrl: "th.jpg", uploadDate: "20260915" });
  });

  it("returns [] for garbage and dedupes by page url ignoring tracking params", () => {
    expect(parseSearchJson("nothing here")).toEqual([]);
    const a = toCandidate({ id: "a", url: "https://youtu.be/a?si=xyz", title: "a", ie_key: "Youtube" })!;
    const b = toCandidate({ id: "a", url: "https://youtu.be/a", title: "a again", ie_key: "Youtube" })!;
    expect(dedupeCandidates([a, b]).map((c) => c.title)).toEqual(["a"]);
  });
});
