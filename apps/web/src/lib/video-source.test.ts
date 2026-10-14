import { describe, expect, it } from "vitest";
import { parseSourceSegment, SOURCE_VIDEO_MAX_SEC, sourceSection, uploadDate, videoLinkKind, videoPageUrl } from "./video-source";

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

describe("parseSourceSegment", () => {
  it("reads blank fields as the whole video", () => {
    expect(parseSourceSegment("", " ")).toEqual({ ok: true, segment: { startSec: null, endSec: null } });
  });
  it("reads timecodes, and a start of 0 as no start", () => {
    expect(parseSourceSegment("0:45", "2:30")).toEqual({ ok: true, segment: { startSec: 45, endSec: 150 } });
    expect(parseSourceSegment("0", "1:00:00")).toMatchObject({ ok: false });
    expect(parseSourceSegment("0:00", "90")).toEqual({ ok: true, segment: { startSec: null, endSec: 90 } });
    expect(parseSourceSegment("1:10", "")).toEqual({ ok: true, segment: { startSec: 70, endSec: null } });
  });
  it("refuses unreadable, reversed and over-long segments", () => {
    expect(parseSourceSegment("abc", "")).toMatchObject({ ok: false });
    expect(parseSourceSegment("", "1:75")).toMatchObject({ ok: false });
    expect(parseSourceSegment("2:00", "1:59")).toMatchObject({ ok: false });
    expect(parseSourceSegment("1:00", `${SOURCE_VIDEO_MAX_SEC + 61}`)).toMatchObject({ ok: false });
    expect(parseSourceSegment("1:00", `${SOURCE_VIDEO_MAX_SEC + 60}`)).toMatchObject({ ok: true });
  });
});

describe("sourceSection", () => {
  it("takes the whole video when nothing is asked, up to the cap", () => {
    expect(sourceSection({ startSec: null, endSec: null }, 255.595)).toEqual({ ok: true, startSec: 0, endSec: 255.6, truncated: false });
    expect(sourceSection({ startSec: null, endSec: null }, 3600)).toEqual({ ok: true, startSec: 0, endSec: SOURCE_VIDEO_MAX_SEC, truncated: true });
  });
  it("cuts the asked segment to the video", () => {
    expect(sourceSection({ startSec: 45, endSec: 150 }, 255.6)).toEqual({ ok: true, startSec: 45, endSec: 150, truncated: false });
    expect(sourceSection({ startSec: 200, endSec: 400 }, 255.6)).toEqual({ ok: true, startSec: 200, endSec: 255.6, truncated: false });
    expect(sourceSection({ startSec: 60, endSec: null }, 3600)).toEqual({ ok: true, startSec: 60, endSec: 60 + SOURCE_VIDEO_MAX_SEC, truncated: true });
  });
  it("refuses a start past the end of the video, and works without a known length", () => {
    expect(sourceSection({ startSec: 300, endSec: null }, 255.6)).toMatchObject({ ok: false });
    expect(sourceSection({ startSec: 10, endSec: 40 }, null)).toEqual({ ok: true, startSec: 10, endSec: 40, truncated: false });
  });
});
