"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createOverlayUploadUrl, registerOverlay, removeOverlay } from "./actions";


const W = 1080;
const H = 1920;

type Props = { kitId: string; overlayUrl: string | null; canEdit: boolean };

function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => (URL.revokeObjectURL(url), resolve({ width: im.naturalWidth, height: im.naturalHeight }));
    im.onerror = () => (URL.revokeObjectURL(url), resolve(null));
    im.src = url;
  });
}

/** Upload / replace / remove a kit's overlay PNG; how it looks on a video is the job of the live preview next to the form. */
export function OverlayUploader({ kitId, overlayUrl, canEdit }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(overlayUrl);
  const [busy, setBusy] = useState<string | null>(null);

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

  return (
    <div className="flex flex-wrap gap-4">
      <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-md border" style={{ background: "repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%) 0 0 / 12px 12px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="Lớp phủ" className="absolute inset-0 h-full w-full" /> : <div className="absolute inset-0 grid place-items-center p-2 text-center text-[10px] text-muted-foreground">chưa có</div>}
      </div>
      <div className="min-w-56 flex-1 space-y-2 text-xs text-muted-foreground">
        <p>
          PNG <b>1080×1920</b>, nền trong suốt, ≤ 12 MB. Phần có hình (khung, dải màu, hoạ tiết góc…) phủ lên video suốt từng cảnh, từ khung hình đầu tới cuối, không mờ dần;
          phần trong suốt để lộ video. Tắt / bật cho từng cảnh trong trình chỉnh sửa.
        </p>
        <p>Xem nó trên video ở khung “Xem trước” bên phải. Đừng đặt chi tiết quan trọng trong vùng đỏ; tránh phủ kín vùng tiêu đề và phụ đề nếu chọn “trên cùng”.</p>
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
      </div>
    </div>
  );
}
