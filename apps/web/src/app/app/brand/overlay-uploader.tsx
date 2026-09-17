"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { headlineBottom } from "@ai-news/video/schema";
import { Button } from "@/components/ui/button";
import { createOverlayUploadUrl, registerOverlay, removeOverlay } from "./actions";

const W = 1080;
const H = 1920;
/** Same numbers as SAFE_ZONES / the text layout of News.tsx, as a share of the frame. */
const pct = (n: number, of: number) => `${(n / of) * 100}%`;

type Props = {
  kitId: string;
  overlayUrl: string | null;
  logoUrl: string | null;
  layer: "under_text" | "top";
  colours: { primary: string; accent: string; text: string; captionBg: string; captionHighlight: string };
  captionPosition: "bottom" | "middle";
  captionFontSize: number;
  canEdit: boolean;
};

function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => (URL.revokeObjectURL(url), resolve({ width: im.naturalWidth, height: im.naturalHeight }));
    im.onerror = () => (URL.revokeObjectURL(url), resolve(null));
    im.src = url;
  });
}

/** Upload / replace / remove a kit's overlay PNG, with a mock frame showing where it sits against the text and the platform UI. */
export function OverlayUploader({ kitId, overlayUrl, logoUrl, layer, colours, captionPosition, captionFontSize, canEdit }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(overlayUrl);
  const [busy, setBusy] = useState<string | null>(null);
  const [guides, setGuides] = useState(true);
  const [dark, setDark] = useState(true);

  const upload = async (file: File) => {
    if (file.type !== "image/png") return void toast.error("Lớp phủ phải là tệp PNG nền trong suốt");
    const size = await imageSize(file);
    if (!size) return void toast.error("Không đọc được ảnh");
    if (size.width !== W || size.height !== H) return void toast.error(`Lớp phủ phải đúng ${W}×${H} px (tệp này ${size.width}×${size.height})`);
    setBusy("Đang tải lên…");
    try {
      const ticket = await createOverlayUploadUrl({ kitId, sizeBytes: file.size, contentType: file.type });
      if (!ticket.ok) return void toast.error(ticket.message);
      const put = await fetch(ticket.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) return void toast.error(`Tải lên thất bại (${put.status}). Kiểm tra CORS của bucket.`);
      setBusy("Đang kiểm tra tệp…");
      const saved = await registerOverlay({ kitId, key: ticket.key });
      if (!saved.ok) return void toast.error(saved.message);
      setUrl(saved.url);
      toast.success(saved.message);
      router.refresh();
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async () => {
    setBusy("Đang gỡ…");
    const res = await removeOverlay({ kitId });
    setBusy(null);
    if (!res.ok) return void toast.error(res.message);
    setUrl(null);
    toast.success(res.message);
    router.refresh();
  };

  const text = (
    <>
      <div className="absolute rounded-[3px] px-[4%] py-[1.5%] text-[9px] font-extrabold leading-tight" style={{ bottom: pct(headlineBottom({ position: captionPosition, fontSize: captionFontSize }, "body"), H), left: pct(60, W), maxWidth: "70%", background: colours.primary, color: colours.text, borderLeft: `3px solid ${colours.accent}` }}>
        Tiêu đề trên màn hình
      </div>
      <div className="absolute flex justify-center" style={{ left: pct(60, W), right: pct(180, W), ...(captionPosition === "middle" ? { top: "48%" } : { bottom: pct(450, H) }) }}>
        <span className="rounded px-2 py-0.5 text-[9px] font-bold" style={{ background: colours.captionBg, color: colours.text }}>
          phụ đề <span style={{ color: colours.captionHighlight }}>đang đọc</span>
        </span>
      </div>
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="absolute object-contain" style={{ top: pct(100, H), right: pct(120, W), height: pct(90, H) }} />
      ) : null}
    </>
  );
  // eslint-disable-next-line @next/next/no-img-element
  const overlay = url ? <img src={url} alt="Lớp phủ" className="absolute inset-0 h-full w-full" /> : null;

  return (
    <div className="flex flex-wrap gap-4">
      <div
        className="relative aspect-[9/16] w-44 shrink-0 overflow-hidden rounded-md border"
        style={{ background: dark ? "linear-gradient(160deg,#334155,#0f172a 55%,#1e293b)" : "repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px" }}
      >
        {layer === "under_text" ? overlay : null}
        {text}
        {layer === "top" ? overlay : null}
        {guides ? (
          <>
            <div className="absolute inset-x-0 top-0 border-b border-dashed border-rose-400/80 bg-rose-400/10" style={{ height: pct(220, H) }} />
            <div className="absolute inset-x-0 bottom-0 border-t border-dashed border-rose-400/80 bg-rose-400/10" style={{ height: pct(420, H) }} />
            <div className="absolute bottom-0 right-0 border-l border-dashed border-rose-400/80 bg-rose-400/10" style={{ top: "50%", width: pct(180, W) }} />
          </>
        ) : null}
        {!url ? <div className="absolute inset-0 grid place-items-center p-3 text-center text-[11px] text-white/70">chưa có lớp phủ</div> : null}
      </div>
      <div className="min-w-56 flex-1 space-y-2 text-xs text-muted-foreground">
        <p>
          PNG <b>1080×1920</b>, nền trong suốt, ≤ 12 MB. Phần có hình (khung, dải màu, hoạ tiết góc…) phủ lên video suốt từng cảnh, từ khung hình đầu tới cuối, không mờ dần;
          phần trong suốt để lộ video. Tắt / bật cho từng cảnh trong trình chỉnh sửa.
        </p>
        <p>Vùng đỏ là chỗ giao diện TikTok / Reels / Shorts che: đừng đặt chi tiết quan trọng ở đó. Tránh phủ kín vùng tiêu đề và phụ đề nếu chọn “trên cùng”.</p>
        <input ref={fileRef} type="file" accept="image/png" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!canEdit || Boolean(busy)} onClick={() => fileRef.current?.click()}>
            {url ? "Thay PNG khác" : "Tải PNG lên"}
          </Button>
          {url ? (
            <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={!canEdit || Boolean(busy)} onClick={() => void remove()}>
              Gỡ lớp phủ
            </Button>
          ) : null}
          {busy ? <span>{busy}</span> : null}
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> vùng an toàn
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> nền video giả lập (bỏ chọn để xem ô caro)
          </label>
        </div>
      </div>
    </div>
  );
}
