"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { brandSchema, OUTPUT, SAFE_ZONES, timelineSchema, type Brand, type Timeline } from "@ai-news/video/schema";
import { Preview } from "@/components/editor/preview";
import { Button } from "@/components/ui/button";

const FPS = OUTPUT.fps;
/** A stand-in photo: a person in the upper third, where faces usually are, so text placement can be judged against it. */
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7aa7d8"/><stop offset=".55" stop-color="#d9c7a8"/><stop offset="1" stop-color="#5b6b52"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#s)"/><rect x="0" y="1180" width="1080" height="740" fill="#3f4a3a"/><rect x="90" y="760" width="230" height="520" fill="#8b8f98"/><rect x="760" y="640" width="260" height="640" fill="#a3a7ae"/><circle cx="540" cy="600" r="150" fill="#e0b08c"/><path d="M250 1500 Q260 880 540 860 Q820 880 830 1500 Z" fill="#27364d"/></svg>`,
)}`;

const SCENES = [
  { id: "s1", kind: "hook" as const, sec: 3, headline: "Metro số 1 kéo dài thêm 12 km" },
  { id: "s2", kind: "body" as const, sec: 3.5, headline: "Chính phủ công bố gói hỗ trợ mới cho doanh nghiệp nhỏ và vừa" },
  { id: "s3", kind: "cta" as const, sec: 2.5, headline: "" },
];
const CAPTIONS = ["Sáng nay, Thành phố Hồ Chí Minh", "công bố kế hoạch mở rộng", "tuyến metro đầu tiên.", "Gói hỗ trợ có hiệu lực", "từ tháng sau trên cả nước.", "Theo dõi để cập nhật."];

function sampleTimeline(brand: Brand, photo: boolean): Timeline {
  let from = 0;
  const scenes = SCENES.map((s) => {
    const durationFrames = Math.round(s.sec * FPS);
    const scene = { id: s.id, kind: s.kind, from, durationFrames, headline: s.headline, visual: photo && s.kind !== "cta" ? { kind: "image" as const, src: PHOTO, kenBurns: false } : { kind: "solid" as const } };
    from += durationFrames;
    return scene;
  });
  const per = (from / FPS / CAPTIONS.length) * 1000;
  const captions = CAPTIONS.map((text, i) => {
    const words = text.split(" ");
    const startMs = Math.round(i * per) + 150;
    const span = per - 250;
    return { text, startMs, endMs: Math.round(startMs + span), words: words.map((w, j) => ({ w, s: Math.round(startMs + (j * span) / words.length), e: Math.round(startMs + ((j + 1) * span) / words.length) })) };
  });
  return timelineSchema.parse({ version: 1, fps: 30, width: 1080, height: 1920, durationFrames: from, language: "vi", title: "Xem trước", source: { name: "VnExpress", url: "https://vnexpress.net" }, brand, scenes, captions, audio: { mixSrc: null, voiceSrc: null, musicSrc: null }, attribution: ["Video: Pexels", "Nhạc: Mubert"] });
}

/** The kit as the form currently reads; null while a field holds something the schema rejects (the last good kit stays on screen). */
function brandFromForm(form: HTMLFormElement, base: Brand): Brand | null {
  const fd = new FormData(form);
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const n = (k: string) => (s(k) === "" ? null : Math.round(Number(s(k))));
  const parsed = brandSchema.safeParse({
    ...base,
    name: s("name") || base.name,
    colours: { primary: s("primary"), accent: s("accent"), background: s("background"), text: s("text"), captionBg: s("captionBg"), captionHighlight: s("captionHighlight") },
    fonts: { heading: s("fontHeading"), body: s("fontBody"), caption: s("fontCaption") },
    caption: { position: s("captionPosition"), fontSize: n("captionFontSize") ?? base.caption.fontSize, uppercase: fd.get("captionUppercase") === "on", highlightWords: fd.get("captionHighlightWords") === "on", x: n("captionX"), y: n("captionY") },
    headline: { fontSize: n("headlineFontSize") ?? base.headline.fontSize, x: n("headlineX"), y: n("headlineY") },
    logoMotion: s("logoMotion"),
    overlayLayer: s("overlayLayer"),
    showSource: fd.get("showSource") === "on",
    outroText: s("outroText") || null,
    logoSrc: fd.get("removeLogo") === "on" ? null : base.logoSrc,
  });
  return parsed.success ? parsed.data : null;
}

type Props = { formId: string; brand: Brand; logoUrl: string | null; overlayUrl: string | null };

/** Live preview of the kit being edited: the real `News` composition on a sample story, re-fed on every change of the form. */
export function BrandPreview({ formId, brand, logoUrl, overlayUrl }: Props) {
  const playerRef = useRef<PlayerRef>(null);
  // `brand` carries R2 keys; the player needs URLs.
  const base = useMemo<Brand>(() => ({ ...brand, logoSrc: logoUrl, overlaySrc: overlayUrl }), [brand, logoUrl, overlayUrl]);
  const [live, setLive] = useState<Brand>(base);
  const [invalid, setInvalid] = useState(false);
  const [guides, setGuides] = useState(true);
  const [photo, setPhoto] = useState(true);
  const [overlayOn, setOverlayOn] = useState(true);

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const read = () => {
      const next = brandFromForm(form, base);
      setInvalid(!next);
      if (next) setLive(next);
    };
    read();
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => {
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
    };
  }, [formId, base]);

  const timeline = useMemo(() => sampleTimeline({ ...live, overlaySrc: overlayOn ? live.overlaySrc : null }, photo), [live, overlayOn, photo]);
  const starts = timeline.scenes.map((s) => s.from);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Preview ref={playerRef} timeline={timeline} width="100%" />
        {guides ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
            <div className="absolute inset-x-0 top-0 border-b border-dashed border-rose-400/80 bg-rose-400/10" style={{ height: pct(SAFE_ZONES.top, OUTPUT.height) }} />
            <div className="absolute inset-x-0 bottom-0 border-t border-dashed border-rose-400/80 bg-rose-400/10" style={{ height: pct(SAFE_ZONES.bottom, OUTPUT.height) }} />
            <div className="absolute bottom-0 right-0 border-l border-dashed border-rose-400/80 bg-rose-400/10" style={{ top: "50%", width: pct(SAFE_ZONES.right, OUTPUT.width) }} />
            <div className="absolute inset-x-0 border-t border-dotted border-cyan-300/80" style={{ top: pct((OUTPUT.height * 2) / 3, OUTPUT.height) }} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {["Mở đầu", "Nội dung", "Kết"].map((label, i) => (
          <Button key={label} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => (playerRef.current?.pause(), playerRef.current?.seekTo(starts[i] + 25))}>
            {label}
          </Button>
        ))}
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => (playerRef.current?.seekTo(0), playerRef.current?.play())}>
          ▶ từ đầu
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> vùng an toàn + vạch 1/3
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} /> ảnh mẫu có người
        </label>
        {live.overlaySrc ? (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={overlayOn} onChange={(e) => setOverlayOn(e.target.checked)} /> lớp phủ
          </label>
        ) : null}
      </div>
      {invalid ? <p className="text-xs text-amber-700 dark:text-amber-400">Có ô đang nhập dở / ngoài giới hạn; đang hiển thị giá trị hợp lệ gần nhất.</p> : null}
      <p className="text-[11px] text-muted-foreground">Đúng bộ dựng hình dùng khi kết xuất, trên một tin mẫu. Thay đổi hiện ngay, chưa lưu cho tới khi bấm Lưu. Vùng đỏ: giao diện TikTok / Reels / Shorts che mất.</p>
    </div>
  );
}
