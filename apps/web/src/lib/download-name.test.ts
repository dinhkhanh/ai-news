import { describe, expect, it } from "vitest";
import { asciiFileName, attachmentDisposition, videoFileName } from "./download-name";

describe("render download name", () => {
  it("keeps a Vietnamese title as the file name", () => {
    expect(videoFileName("Chiên cá không bắn dầu: 4 bước đơn giản")).toBe("Chiên cá không bắn dầu 4 bước đơn giản.mp4");
  });

  it("drops characters file systems refuse and collapses whitespace", () => {
    expect(videoFileName('  A/B\\C*D?"E"<F>|G\n  H  ')).toBe("A B C D E F G H.mp4");
  });

  it("falls back when the title is empty or only punctuation", () => {
    expect(videoFileName(null)).toBe("video.mp4");
    expect(videoFileName(" ... ")).toBe("video.mp4");
  });

  it("shortens a long title at a word", () => {
    const name = videoFileName(`${"Tin nóng ".repeat(20)}hết`);
    expect([...name.replace(/\.mp4$/, "")].length).toBeLessThanOrEqual(80);
    expect(name.endsWith(" .mp4")).toBe(false);
    expect(name).toMatch(/nóng\.mp4$/);
  });

  it("gives an ASCII stand-in without accents", () => {
    expect(asciiFileName("Đà Nẵng: “mưa lớn”.mp4")).toBe("Da Nang: _mua lon_.mp4");
  });

  it("builds an attachment disposition with both names", () => {
    expect(attachmentDisposition("Cá (rán) đẹp.mp4")).toBe(`attachment; filename="Ca (ran) dep.mp4"; filename*=UTF-8''C%C3%A1%20%28r%C3%A1n%29%20%C4%91%E1%BA%B9p.mp4`);
  });
});
