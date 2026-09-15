import { brandSchema, type Timeline } from "./schema";

/** Studio preview data for the News composition (no network media). */
export const sampleTimeline: Timeline = {
  version: 1,
  fps: 30,
  width: 1080,
  height: 1920,
  durationFrames: 12 * 30,
  language: "vi",
  title: "Metro số 1 mở rộng",
  source: { name: "VnExpress", url: "https://vnexpress.net" },
  brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {}, outroText: "Theo dõi để cập nhật tin mới" }),
  scenes: [
    { id: "s1", kind: "hook", from: 0, durationFrames: 120, headline: "Metro số 1 kéo dài thêm 12 km", visual: { kind: "solid" }, credit: null, voiceSrc: null },
    { id: "s2", kind: "body", from: 120, durationFrames: 150, headline: "Khởi công quý ba năm 2027", visual: { kind: "solid" }, credit: null, voiceSrc: null },
    { id: "s3", kind: "cta", from: 270, durationFrames: 90, headline: "", visual: { kind: "solid" }, credit: null, voiceSrc: null },
  ],
  captions: [
    { text: "Sáng nay, Thành phố Hồ Chí Minh", startMs: 200, endMs: 2200, words: [{ w: "Sáng", s: 200, e: 600 }, { w: "nay,", s: 600, e: 1000 }, { w: "Thành", s: 1000, e: 1300 }, { w: "phố", s: 1300, e: 1600 }, { w: "Hồ", s: 1600, e: 1900 }, { w: "Chí", s: 1900, e: 2050 }, { w: "Minh", s: 2050, e: 2200 }] },
    { text: "công bố kế hoạch mở rộng metro", startMs: 2300, endMs: 4200, words: [] },
  ],
  audio: { mixSrc: null, voiceSrc: null, musicSrc: null, musicGainDb: -12 },
  attribution: ["Video: Pexels", "Nhạc: Mubert"],
  coverAtSec: null,
};
