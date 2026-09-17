import { describe, expect, it } from "vitest";
import { validateInvoke } from "./server-validate";

const dl = (over: Record<string, unknown> = {}) => ({ action: "web-video", input: { url: "https://www.youtube.com/watch?v=5mIxqMPRwpU" }, output: { key: "media/org_1/proj-2/webvideo/abc-0.mp4" }, trim: { startSec: 8, endSec: 18 }, ...over });

describe("web-video API request validation", () => {
  it("accepts a section download of a supported video page", () => {
    expect(validateInvoke(dl())).toEqual({ ok: true, event: { action: "web-video", input: { url: "https://www.youtube.com/watch?v=5mIxqMPRwpU" }, output: { key: "media/org_1/proj-2/webvideo/abc-0.mp4" }, trim: { startSec: 8, endSec: 18 } } });
  });

  it("rejects internal, plain-http and unknown hosts", () => {
    for (const url of ["http://192.168.1.1/video.mp4", "https://192.168.1.1/watch?v=x", "http://www.youtube.com/watch?v=5mIxqMPRwpU", "https://example.com/v.mp4", "https://youtube.com.evil.test/watch?v=5mIxqMPRwpU"]) {
      expect(validateInvoke(dl({ input: { url } })).ok, url).toBe(false);
    }
  });

  it("only writes to this app's web-video paths", () => {
    for (const key of ["renders/final.mp4", "media/o/p/uploads/x.mp4", "media/o/p/webvideo/../../x.mp4", "media/o/p/webvideo/x.webm"]) {
      expect(validateInvoke(dl({ output: { key } })).ok, key).toBe(false);
    }
    expect(validateInvoke(dl({ output: { key: "tmp/smoke/test.mp4" } })).ok).toBe(true);
  });

  it("requires a bounded trim", () => {
    expect(validateInvoke(dl({ trim: undefined })).ok).toBe(false);
    expect(validateInvoke(dl({ trim: { startSec: 0, endSec: 1000 } })).ok).toBe(false);
    expect(validateInvoke(dl({ trim: { startSec: 10, endSec: 5 } })).ok).toBe(false);
  });

  it("serves search with a clamped limit and filtered urls, nothing else", () => {
    expect(validateInvoke({ action: "web-video-search", input: { query: " bão số 3 ", limit: 99, urls: ["https://youtu.be/5mIxqMPRwpU", "http://10.0.0.1/"] } })).toEqual({ ok: true, event: { action: "web-video-search", input: { query: "bão số 3", urls: ["https://youtu.be/5mIxqMPRwpU"], limit: 20 } } });
    expect(validateInvoke({ action: "web-video-search", input: { query: "-x option" } }).ok).toBe(false);
    expect(validateInvoke({ action: "web-video-search", input: {} }).ok).toBe(false);
    expect(validateInvoke({ action: "mix" })).toMatchObject({ ok: false, status: 403 });
    expect(validateInvoke(null).ok).toBe(false);
  });
});
