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
    { id: "s2", kind: "body", from: 120, durationFrames: 150, headline: "Khởi công quý ba năm 2027", visual: { kind: "image", src: LANDSCAPE_PHOTO, kenBurns: true, focus: null, sketch: null }, shots: [], credit: "Ảnh: VnExpress", voiceSrc: null, overlay: true },
    { id: "s3", kind: "cta", from: 270, durationFrames: 90, headline: "", visual: { kind: "solid" }, shots: [], credit: null, voiceSrc: null, overlay: true },
  ],
  captions: [
    { text: "Sáng nay, Thành phố Hồ Chí Minh", startMs: 200, endMs: 2200, words: [{ w: "Sáng", s: 200, e: 600 }, { w: "nay,", s: 600, e: 1000 }, { w: "Thành", s: 1000, e: 1300, j: true }, { w: "phố", s: 1300, e: 1600 }, { w: "Hồ", s: 1600, e: 1900, j: true }, { w: "Chí", s: 1900, e: 2050, j: true }, { w: "Minh", s: 2050, e: 2200 }] },
    { text: "công bố kế hoạch mở rộng metro", startMs: 2300, endMs: 4200, words: [] },
  ],
  audio: { mixSrc: null, voiceSrc: null, musicSrc: null, musicGainDb: -12 },
  attribution: ["Nhạc: Mubert"],
  coverAtSec: null,
};

/** Studio preview of the motion graphics (0.15.0): a `remotion` spec scene, a `hyperframes` scene, then the CTA. */
export const sampleMotionTimeline: Timeline = {
  ...sampleTimeline,
  durationFrames: 18 * 30,
  scenes: [
    {
      id: "s1",
      kind: "hook",
      from: 0,
      durationFrames: 240,
      headline: "Metro số 1 kéo dài thêm 12 km",
      visual: { kind: "solid" },
      shots: [
        {
          from: 0,
          durationFrames: 240,
          credit: null,
          visual: {
            kind: "motion",
            images: [],
            spec: {
              mood: "brand",
              background: "grid",
              backgroundImage: null,
              beats: [
                {
                  at: 0,
                  align: "center",
                  elements: [
                    { type: "kicker", delay: 0, enter: "slide", text: null, label: "Giao thông", value: null, prefix: null, suffix: null, decimals: null, items: null, emoji: null, image: null, emphasis: null },
                    { type: "title", delay: 0.3, enter: "rise", text: "Metro số 1 kéo dài thêm 12 km", label: null, value: null, prefix: null, suffix: null, decimals: null, items: null, emoji: null, image: null, emphasis: ["12 km"] },
                  ],
                },
                {
                  at: 3.5,
                  align: "center",
                  elements: [
                    { type: "stat", delay: 0, enter: "pop", text: "vốn đầu tư dự kiến", label: null, value: 40500, prefix: null, suffix: " tỷ đồng", decimals: 0, items: null, emoji: null, image: null, emphasis: null },
                    {
                      type: "bars",
                      delay: 0.8,
                      enter: "fade",
                      text: null,
                      label: "Chiều dài (km)",
                      value: null,
                      prefix: null,
                      suffix: null,
                      decimals: 1,
                      items: [
                        { label: "Tuyến hiện tại", value: 19.7, detail: null },
                        { label: "Đoạn mở rộng", value: 12, detail: null },
                      ],
                      emoji: null,
                      image: null,
                      emphasis: null,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      credit: null,
      voiceSrc: null,
      overlay: true,
    },
    {
      id: "s2",
      kind: "body",
      from: 240,
      durationFrames: 180,
      headline: "Khởi công quý ba năm 2027",
      visual: { kind: "solid" },
      shots: [
        {
          from: 0,
          durationFrames: 180,
          credit: null,
          visual: {
            kind: "hyperframes",
            images: [],
            html: `<div id="stage" data-composition-id="shot" data-width="1080" data-height="1920" data-start="0" data-duration="6">
<style>#stage{position:absolute;inset:0;background:radial-gradient(circle at 30% 30%,var(--brand-primary),var(--brand-bg))}
.t{position:absolute;left:80px;right:140px;top:420px;font-size:110px;font-weight:900;line-height:1.05}
.d{position:absolute;left:80px;top:860px;font-size:190px;font-weight:900;color:var(--brand-accent)}
.bar{position:absolute;left:80px;top:1180px;height:24px;width:860px;background:var(--brand-accent);transform-origin:left center}</style>
<div class="t" id="t">Khởi công</div><div class="d" id="d">Q3/2027</div><div class="bar" id="bar"></div>
<script>var tl=gsap.timeline({paused:true});
tl.from("#t",{y:80,opacity:0,duration:.7,ease:"power3.out"},0.2).from("#d",{scale:.6,opacity:0,duration:.8,ease:"back.out(1.7)"},0.8).from("#bar",{scaleX:0,duration:1.2,ease:"power2.inOut"},1.4);
window.__timelines=window.__timelines||{};window.__timelines.shot=tl;</script></div>`,
          },
        },
      ],
      credit: null,
      voiceSrc: null,
      overlay: true,
    },
    { id: "s3", kind: "cta", from: 420, durationFrames: 120, headline: "", visual: { kind: "solid" }, shots: [], credit: null, voiceSrc: null, overlay: true },
  ],
};

/** A portrait "photo" (one figure in front of a building) for the sketch sample's cover-fitted shots. */
const PORTRAIT_PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1400"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc3e6"/><stop offset="1" stop-color="#e9dcc2"/></linearGradient></defs><rect width="900" height="1400" fill="url(#s)"/><rect x="60" y="240" width="320" height="900" fill="#b8a48a"/><rect x="520" y="160" width="320" height="980" fill="#8e9aa8"/><g fill="#5d6b7a">${Array.from({ length: 8 }, (_, r) => `<rect x="560" y="${200 + r * 110}" width="70" height="70"/><rect x="730" y="${200 + r * 110}" width="70" height="70"/>`).join("")}</g><circle cx="450" cy="620" r="130" fill="#e3b591"/><path d="M200 1400 Q230 820 450 790 Q670 820 700 1400 Z" fill="#2f4a6b"/></svg>`,
)}`;

/** Studio preview of the hand-drawn stills (0.16.0): one shot per style, each opening on the photo. */
export const sampleSketchTimeline: Timeline = {
  ...sampleTimeline,
  durationFrames: 15 * 30,
  scenes: (["pencil", "ink", "colour"] as const).map((style, i) => ({
    id: `s${i + 1}`,
    kind: i === 0 ? ("hook" as const) : i === 2 ? ("cta" as const) : ("body" as const),
    from: i * 150,
    durationFrames: 150,
    headline: i === 2 ? "" : ["Bút chì", "Bút mực"][i],
    visual: { kind: "image" as const, src: i === 1 ? LANDSCAPE_PHOTO : PORTRAIT_PHOTO, kenBurns: true, focus: null, sketch: { style } },
    shots: [],
    credit: "Ảnh: VnExpress",
    voiceSrc: null,
    overlay: true,
  })),
};
