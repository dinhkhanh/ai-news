import type { Cartoon } from "./cartoon";
import { sampleComicPage } from "./comic-sample";
import { brandSchema, type Timeline } from "./schema";

/** Studio preview of the cartoon look (`Cartoon.tsx`): the sample comic page, its panels painted with flat shapes. */
const picture = (hue: number, w: number, h: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="hsl(${hue},55%,72%)"/><rect y="${h * 0.7}" width="${w}" height="${h * 0.3}" fill="hsl(${hue + 30},40%,45%)"/><circle cx="${w * 0.3}" cy="${h * 0.5}" r="${h * 0.12}" fill="#f4c9a0" stroke="#111" stroke-width="6"/><circle cx="${w * 0.72}" cy="${h * 0.48}" r="${h * 0.1}" fill="#e8b48a" stroke="#111" stroke-width="6"/></svg>`,
  )}`;

const panels: Cartoon["panels"] = Object.fromEntries(
  sampleComicPage.page.panels.map((p, i) => [
    p.id,
    {
      page: p.id === "d" || p.id === "e" ? 2 : 1,
      w: p.rect.w,
      h: p.rect.h,
      src: picture(30 + i * 55, Math.round(p.rect.w), Math.round(p.rect.h)),
      imgW: Math.round(p.rect.w),
      imgH: Math.round(p.rect.h),
      crop: null,
      balloons: p.lettering.map((b) => ({ ...b, rect: b.rect ? { ...b.rect, x: b.rect.x - p.rect.x, y: b.rect.y - p.rect.y } : null, tail: b.tail ? { x: b.tail.x - p.rect.x, y: b.tail.y - p.rect.y } : null })),
    },
  ]),
);

const beats: Array<{ panel: string; balloon: string | null; face: { x: number; y: number; w: number; h: number } | null; sec: number }> = [
  { panel: "a", balloon: "b1", face: null, sec: 3.5 },
  { panel: "b", balloon: "b2", face: { x: 0.18, y: 0.38, w: 0.24, h: 0.24 }, sec: 3 },
  { panel: "c", balloon: null, face: null, sec: 2 },
  { panel: "d", balloon: "b4", face: { x: 0.62, y: 0.38, w: 0.2, h: 0.2 }, sec: 4 },
  { panel: "e", balloon: "b5", face: { x: 0.18, y: 0.38, w: 0.24, h: 0.24 }, sec: 2.5 },
  { panel: "e", balloon: null, face: null, sec: 3 },
];

let at = 0;
const scenes: Timeline["scenes"] = beats.map((b, i) => {
  const durationFrames = Math.round(b.sec * 30);
  const s = {
    id: `s${i + 1}`,
    kind: i === 0 ? ("hook" as const) : i === beats.length - 1 ? ("cta" as const) : ("body" as const),
    from: at,
    durationFrames,
    headline: i === 0 ? "Ngọn đèn lồng của bà" : i === beats.length - 1 ? "Hết" : "",
    visual: { kind: "solid" as const },
    shots: [],
    credit: "Minh hoạ AI (Gemini)",
    voiceSrc: null,
    overlay: false,
    cartoon: { panel: b.panel, balloon: b.balloon, face: b.face },
  };
  at += durationFrames;
  return s;
});

export const sampleCartoonTimeline: Timeline = {
  version: 1,
  fps: 30,
  width: 1080,
  height: 1920,
  durationFrames: at,
  language: "vi",
  title: "Ngọn đèn lồng của bà",
  source: { name: "Truyện “Ngọn đèn lồng của bà”", url: "" },
  brand: brandSchema.parse({ colours: {}, fonts: {}, caption: {} }),
  scenes,
  captions: [],
  audio: { mixSrc: null, voiceSrc: null, musicSrc: null, musicGainDb: -12 },
  attribution: ["Nhạc: Mubert"],
  coverAtSec: null,
  cartoon: { font: "itim", readingDirection: "ltr", panels },
};
