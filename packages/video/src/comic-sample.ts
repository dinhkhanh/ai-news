import type { ComicDoc, ComicPage } from "./comic";

/** Studio preview of the `ComicPage` composition: one page with every lettering kind, no pictures. */
const panel = (id: string, x: number, y: number, w: number, h: number, description: string): ComicPage["panels"][number] => ({
  id,
  rect: { x, y, w, h },
  script: { size: "medium", shot: "medium", settingId: null, time: "day", mood: "", characters: [], description },
  image: null,
  variants: [],
  error: null,
  lettering: [],
});

const page: ComicPage = {
  id: "p1",
  beat: "Sample",
  layout: "wide-top",
  height: 1754,
  panels: [
    {
      ...panel("a", 50, 50, 1140, 520, "Wide shot of a dusty attic, warm light through a small window."),
      lettering: [{ id: "b1", kind: "caption", speaker: null, text: "Gác xép nhà bà chưa ai lên từ mùa hè năm ngoái.", rect: { x: 80, y: 80, w: 520, h: 110 }, tail: null, fontSize: 34, manual: false }],
    },
    {
      ...panel("b", 50, 592, 724, 560, "Medium shot, a girl lifting a sheet off a wooden chest."),
      lettering: [{ id: "b2", kind: "thought", speaker: "lan", text: "Đồ chơi Trung thu chắc ở trong này…", rect: { x: 330, y: 620, w: 400, h: 150 }, tail: { x: 300, y: 860 }, fontSize: 34, manual: false }],
    },
    {
      ...panel("c", 796, 592, 394, 560, "Extreme close-up of a faded red paper star lantern."),
      lettering: [{ id: "b3", kind: "sfx", speaker: null, text: "Sột soạt…", rect: { x: 830, y: 640, w: 320, h: 110 }, tail: null, fontSize: 64, manual: false }],
    },
    {
      ...panel("d", 50, 1174, 560, 530, "Close-up of the girl holding the lantern, grandmother at the attic hatch."),
      lettering: [{ id: "b4", kind: "speech", speaker: "ba", text: "Cháu tìm thấy nó rồi à? Chiếc đèn ấy còn già hơn cả bố cháu đấy.", rect: { x: 80, y: 1200, w: 470, h: 190 }, tail: { x: 420, y: 1520 }, fontSize: 34, manual: false }],
    },
    {
      ...panel("e", 632, 1174, 558, 530, "The girl raising a folded note found inside the lantern."),
      lettering: [{ id: "b5", kind: "shout", speaker: "lan", text: "Bà ơi! Trong đèn có tờ giấy!", rect: { x: 680, y: 1200, w: 460, h: 150 }, tail: { x: 800, y: 1500 }, fontSize: 34, manual: false }],
    },
  ],
};

export const sampleComicPage: { format: ComicDoc["format"]; font: ComicDoc["font"]; page: ComicPage; srcs: Record<string, string>; credit: string | null } = {
  format: { id: "a4", width: 1240, height: 1754, scroll: false },
  font: "itim",
  page,
  srcs: {},
  credit: "Minh hoạ bởi AI (Gemini)",
};
