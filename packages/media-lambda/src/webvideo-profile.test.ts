import { describe, expect, it } from "vitest";
import { WEB_VIDEO_PROFILES, webVideoProfile } from "./webvideo-profile";

describe("webVideoProfile", () => {
  it("encodes at full quality off Lambda (the office Mac, a NAS)", () => {
    expect(webVideoProfile({})).toBe(WEB_VIDEO_PROFILES.full);
    expect(WEB_VIDEO_PROFILES.full).toMatchObject({ preset: "medium", sort: ["-S", "res:1080"] });
  });
  it("takes the fast profile on the Lambda fallback, unless told otherwise", () => {
    expect(webVideoProfile({ AWS_LAMBDA_FUNCTION_NAME: "ai-news-media" })).toBe(WEB_VIDEO_PROFILES.fast);
    expect(webVideoProfile({ AWS_LAMBDA_FUNCTION_NAME: "ai-news-media", WEB_VIDEO_PROFILE: "full" })).toBe(WEB_VIDEO_PROFILES.full);
    expect(webVideoProfile({ WEB_VIDEO_PROFILE: "fast" })).toBe(WEB_VIDEO_PROFILES.fast);
    expect(WEB_VIDEO_PROFILES.fast.preset).toBe("veryfast");
  });
});
