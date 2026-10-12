"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createLibraryUpload, registerLibraryUpload, removeLibraryReference, type UploadTarget } from "./library-actions";

const TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Browser → R2 with a presigned PUT, then the server checks the file and records it. */
function useUpload(target: UploadTarget & { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const upload = async (file: File) => {
    if (!TYPES.includes(file.type)) return void toast.error("Chỉ nhận ảnh PNG, JPEG hoặc WebP");
    if (file.size > 10 * 1024 * 1024) return void toast.error("Ảnh tối đa 10 MB");
    setBusy("Đang tải lên…");
    try {
      const ticket = await createLibraryUpload({ ...target, contentType: file.type, sizeBytes: file.size });
      if (!ticket.ok) return void toast.error(ticket.message);
      const put = await fetch(ticket.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) return void toast.error(`Tải lên thất bại (${put.status}). Kiểm tra CORS của bucket.`);
      setBusy("Đang kiểm tra ảnh…");
      const saved = await registerLibraryUpload({ ...target, key: ticket.key });
      (saved.ok ? toast.success : toast.error)(saved.message);
      if (saved.ok) router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, upload, router };
}

/**
 * Reference images of a style (samples of the technique) or a character (photos or drawings of their look), sent with
 * every drawing that uses them. At most `max`.
 */
export function ReferenceImages({ target, id, items, max, canEdit, hint }: { target: "style" | "character"; id: string; items: { key: string; url: string }[]; max: number; canEdit: boolean; hint: string }) {
  const file = useRef<HTMLInputElement>(null);
  const { busy, upload, router } = useUpload({ target, id });
  const [removing, setRemoving] = useState<string | null>(null);
  const remove = async (key: string) => {
    setRemoving(key);
    const res = await removeLibraryReference({ target, id, key });
    setRemoving(null);
    (res.ok ? toast.success : toast.error)(res.message);
    if (res.ok) router.refresh();
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <ul className="flex flex-wrap gap-2">
        {items.map((it, i) => (
          <li key={it.key} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL */}
            <img src={it.url} alt={`Ảnh tham chiếu ${i + 1}`} className="size-20 rounded-md border object-cover" />
            {canEdit ? (
              <button
                type="button"
                aria-label={`Bỏ ảnh tham chiếu ${i + 1}`}
                disabled={removing === it.key}
                onClick={() => void remove(it.key)}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-xs shadow hover:bg-muted"
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
        {canEdit && items.length < max ? (
          <li>
            <input ref={file} type="file" accept={TYPES.join(",")} className="hidden" onChange={(e) => (e.target.files?.[0] ? void upload(e.target.files[0]).then(() => (e.target.value = "")) : undefined)} />
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => file.current?.click()}
              className="grid size-20 place-items-center rounded-md border border-dashed text-center text-xs text-muted-foreground hover:bg-muted disabled:opacity-60"
            >
              {busy ?? "+ Thêm ảnh"}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** "Tải bản mẫu của bạn": the member's own drawing becomes the character's accepted sheet in one style. */
export function SheetUpload({ characterId, styleId, disabled }: { characterId: string; styleId: string; disabled?: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const { busy, upload } = useUpload({ target: "sheet", id: characterId, styleId });
  return (
    <>
      <input ref={file} type="file" accept={TYPES.join(",")} className="hidden" onChange={(e) => (e.target.files?.[0] ? void upload(e.target.files[0]).then(() => (e.target.value = "")) : undefined)} />
      <Button type="button" size="sm" variant="ghost" disabled={disabled || Boolean(busy)} onClick={() => file.current?.click()}>
        {busy ?? "Tải bản mẫu của bạn"}
      </Button>
    </>
  );
}
