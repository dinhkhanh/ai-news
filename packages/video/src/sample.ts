import { brandSchema, type Timeline } from "./schema";

/** A 16:9 "photo" (sky, ground, two figures) to show the landscape layout: full width on a blurred backdrop. */
const LANDSCAPE_PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f9fd6"/><stop offset=".6" stop-color="#d8c9ab"/><stop offset="1" stop-color="#4f6a48"/></linearGradient></defs><rect width="1600" height="900" fill="url(#s)"/><rect x="0" y="600" width="1600" height="300" fill="#3c4a38"/><rect x="120" y="260" width="300" height="420" fill="#8b8f98"/><rect x="1180" y="200" width="320" height="480" fill="#a3a7ae"/><circle cx="700" cy="330" r="90" fill="#e0b08c"/><path d="M520 820 Q540 470 700 450 Q860 470 880 820 Z" fill="#27364d"/><circle cx="980" cy="360" r="80" fill="#d9a583"/><path d="M830 820 Q850 500 980 480 Q1110 500 1130 820 Z" fill="#7a2e2e"/></svg>`,
)}`;

/** Studio preview data for the News composition (no network media). */
export const sampleTimeline: Timeline = {
  version: 1,
  fps: 30,
  width: 1080,
  height: 1920,
  durationFrames: 12 * 30,
  language: "vi",
  title: "Metro số 1 mở rộng",
  source: { name: "VnExpress", url: "https://vnexpress.net/metro-so-1-keo-dai-them-12-km-4712345.html" },
  brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {}, outroText: "Theo dõi để cập nhật tin mới" }),
  scenes: [
    { id: "s1", kind: "hook", from: 0, durationFrames: 120, headline: "Metro số 1 kéo dài thêm 12 km", visual: { kind: "solid" }, shots: [], credit: "Ảnh: VnExpress", voiceSrc: null, overlay: true },
    { id: "s2", kind: "body", from: 120, durationFrames: 150, headline: "Khởi công quý ba năm 2027", visual: { kind: "image", src: LANDSCAPE_PHOTO, kenBurns: true, focus: null }, shots: [], credit: "Ảnh: VnExpress", voiceSrc: null, overlay: true },
    { id: "s3", kind: "cta", from: 270, durationFrames: 90, headline: "", visual: { kind: "solid" }, shots: [], credit: null, voiceSrc: null, overlay: true },
  ],
  captions: [
    { text: "Sáng nay, Thành phố Hồ Chí Minh", startMs: 200, endMs: 2200, words: [{ w: "Sáng", s: 200, e: 600 }, { w: "nay,", s: 600, e: 1000 }, { w: "Thành", s: 1000, e: 1300 }, { w: "phố", s: 1300, e: 1600 }, { w: "Hồ", s: 1600, e: 1900 }, { w: "Chí", s: 1900, e: 2050 }, { w: "Minh", s: 2050, e: 2200 }] },
    { text: "công bố kế hoạch mở rộng metro", startMs: 2300, endMs: 4200, words: [] },
  ],
  audio: { mixSrc: null, voiceSrc: null, musicSrc: null, musicGainDb: -12 },
  attribution: ["Nhạc: Mubert"],
  coverAtSec: null,
};
