import { describe, expect, it } from "vitest";
import { sourceVideoShots, uploadDate, videoLinkKind, videoPageUrl } from "./video-source";

describe("videoPageUrl", () => {
  it("keeps the video id and drops tracking queries", () => {
    expect(videoPageUrl("https://www.tiktok.com/@tranhieu9492/video/7685246867982011655?is_from_webapp=1&sender_device=pc")).toBe("https://www.tiktok.com/@tranhieu9492/video/7685246867982011655");
    expect(videoPageUrl("https://www.facebook.com/reel/946055151335969")).toBe("https://www.facebook.com/reel/946055151335969");
    expect(videoPageUrl("https://m.facebook.com/reel/946055151335969/?mibextid=abc")).toBe("https://www.facebook.com/reel/946055151335969");
    expect(videoPageUrl("https://www.facebook.com/watch/?v=123&ref=sharing")).toBe("https://www.facebook.com/watch?v=123");
    expect(videoPageUrl("https://www.youtube.com/shorts/tov5lHVESlo")).toBe("https://www.youtube.com/shorts/tov5lHVESlo");
    expect(videoPageUrl("http://youtube.com/watch?v=dQw4w9WgXcQ&t=10s&si=x")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(videoPageUrl("youtu.be/dQw4w9WgXcQ?si=abc")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(videoPageUrl("https://vimeo.com/123456/")).toBe("https://www.vimeo.com/123456");
  });
  it("is null for anything that is not a video page", () => {
    expect(videoPageUrl("https://vnexpress.net/bai-viet-123.html")).toBeNull();
    expect(videoPageUrl("https://www.youtube.com/@channel")).toBeNull();
    expect(videoPageUrl("https://www.tiktok.com/@user")).toBeNull();
    expect(videoPageUrl("https://www.facebook.com/somepage")).toBeNull();
    expect(videoPageUrl("ftp://youtube.com/watch?v=x")).toBeNull();
    expect(videoPageUrl("")).toBeNull();
  });
});

describe("videoLinkKind", () => {
  it("tells video pages, share links and articles apart", () => {
    expect(videoLinkKind("https://www.youtube.com/shorts/tov5lHVESlo")).toBe("page");
    expect(videoLinkKind("https://vt.tiktok.com/ZSqTkuH9X/")).toBe("short");
    expect(videoLinkKind("https://vm.tiktok.com/ZMabc/")).toBe("short");
    expect(videoLinkKind("https://www.tiktok.com/t/ZTabc/")).toBe("short");
    expect(videoLinkKind("https://www.facebook.com/share/r/1AbCdEf/")).toBe("short");
    expect(videoLinkKind("https://www.facebook.com/share/p/1AbCdEf/")).toBeNull();
    expect(videoLinkKind("https://tuoitre.vn/thoi-su/bai-1.htm")).toBeNull();
  });
});

describe("uploadDate", () => {
  it("reads YYYYMMDD", () => {
    expect(uploadDate("20260915")?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(uploadDate(null)).toBeNull();
    expect(uploadDate("2026-09-15")).toBeNull();
  });
});

describe("sourceVideoShots", () => {
  it("plays the footage on continuously across shots and scenes", () => {
    const out = sourceVideoShots([{ id: "s1", sec: 8, shots: 2 }, { id: "s2", sec: 3, shots: 1 }], 60);
    expect(out.s1).toEqual([{ trimStartSec: 0, clipDurationSec: 4 }, { trimStartSec: 4, clipDurationSec: 4 }]);
    expect(out.s2).toEqual([{ trimStartSec: 8, clipDurationSec: 3 }]);
  });
  it("starts over when the voice-over outlasts the video", () => {
    const out = sourceVideoShots([{ id: "s1", sec: 8, shots: 2 }, { id: "s2", sec: 5, shots: 1 }], 10);
    expect(out.s2).toEqual([{ trimStartSec: 0, clipDurationSec: 5 }]);
  });
  it("loops a video shorter than one shot", () => {
    const out = sourceVideoShots([{ id: "s1", sec: 4, shots: 1 }, { id: "s2", sec: 4, shots: 1 }], 3);
    expect(out.s1).toEqual([{ trimStartSec: 0, clipDurationSec: 3 }]);
    expect(out.s2).toEqual([{ trimStartSec: 0, clipDurationSec: 3 }]);
  });
});
