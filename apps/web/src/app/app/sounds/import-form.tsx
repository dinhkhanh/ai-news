"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { audioContentType, pixabayMusicPage, SOUND_KIND_LABEL, SOUND_KINDS, SOUND_MAX_BYTES, type SoundKind } from "@/lib/media/sound-library";
import { createSoundUpload, registerSoundImport } from "./actions";

/** Length of a local audio file from its metadata (null when the browser cannot tell within 5 s). */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 5000);
    a.preload = "metadata";
    a.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(a.duration) ? a.duration : null);
    };
    a.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    a.src = url;
  });
}

/**
 * Bring a file into a collection: a Pixabay Music download (its page URL is required, the Pixabay licence is filled
 * in) or the member's own file (they confirm the rights). Browser → presigned PUT → `registerSoundImport`.
 */
export function ImportForm({ mode, collectionId, collectionName, idPrefix }: { mode: "pixabay" | "upload"; collectionId: string | null; collectionName: string | null; idPrefix: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pageUrl, setPageUrl] = useState("");
  const [rights, setRights] = useState(false);
  const pageOk = mode !== "pixabay" || pixabayMusicPage(pageUrl) !== null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!collectionId) return toast.error("Chọn hoặc tạo một bộ sưu tập trước");
    if (!file) return toast.error("Chọn tệp âm thanh");
    if (!audioContentType(file.name, file.type)) return toast.error("Chỉ nhận MP3, WAV, M4A, OGG hoặc FLAC");
    if (file.size > SOUND_MAX_BYTES) return toast.error("Tệp tối đa 25 MB");
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const ticket = await createSoundUpload({ collectionId, filename: file.name, contentType: file.type, sizeBytes: file.size });
      if (!ticket.ok) throw new Error(ticket.message);
      const put = await fetch(ticket.url, { method: "PUT", body: file, headers: { "Content-Type": ticket.contentType } });
      if (!put.ok) throw new Error(`Tải tệp lên thất bại (HTTP ${put.status})`);
      const r = await registerSoundImport({
        collectionId,
        key: ticket.key,
        provider: mode,
        pageUrl: mode === "pixabay" ? pageUrl : undefined,
        title: String(fd.get("title") ?? ""),
        creator: String(fd.get("creator") ?? ""),
        kind: String(fd.get("kind") ?? "music") as SoundKind,
        durationSec: await readDuration(file),
        filename: file.name,
        rightsConfirmed: rights,
      });
      if (!r.ok) throw new Error(r.message);
      toast.success(r.message);
      formRef.current?.reset();
      setFile(null);
      setPageUrl("");
      setRights(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Không nhập được tệp");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-3" aria-busy={busy || undefined}>
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === "pixabay" ? (
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`${idPrefix}-page`}>Link trang bài trên Pixabay</Label>
            <Input id={`${idPrefix}-page`} type="url" required value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="https://pixabay.com/music/…" aria-invalid={pageUrl !== "" && !pageOk ? true : undefined} />
            {pageUrl !== "" && !pageOk ? <p className="text-xs text-destructive">Cần link trang một bài nhạc hoặc hiệu ứng: pixabay.com/music/… hoặc pixabay.com/sound-effects/…</p> : null}
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-title`}>Tên</Label>
          <Input id={`${idPrefix}-title`} name="title" maxLength={200} placeholder={mode === "pixabay" ? "lấy từ link nếu để trống" : "lấy từ tên tệp nếu để trống"} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-creator`}>{mode === "pixabay" ? "Tác giả trên Pixabay" : "Tác giả / nguồn"}</Label>
          <Input id={`${idPrefix}-creator`} name="creator" maxLength={120} placeholder="không bắt buộc" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-kind`}>Loại</Label>
          <NativeSelect id={`${idPrefix}-kind`} name="kind" defaultValue="music" className="w-full">
            {SOUND_KINDS.map((k) => (
              <option key={k} value={k}>
                {SOUND_KIND_LABEL[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label htmlFor={`${idPrefix}-file`} className="flex min-h-16 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-muted/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/40">
          <Upload className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{file ? file.name : "Chọn tệp MP3, WAV, M4A, OGG, FLAC (tối đa 25 MB)"}</span>
          <input id={`${idPrefix}-file`} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {mode === "upload" ? (
        <label className="flex min-h-10 items-start gap-2 text-sm">
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
          <span>Tôi có quyền dùng tệp này trong video của workspace (tự sản xuất, đã mua, hoặc giấy phép cho phép).</span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex-1 text-xs text-muted-foreground">
          {collectionName ? `Thêm vào «${collectionName}»` : "Chưa chọn bộ sưu tập"}
          {mode === "pixabay" ? " · Pixabay Content License" : ""}
        </span>
        <Button type="submit" size="sm" disabled={busy || !collectionId || !file || !pageOk || (mode === "upload" && !rights)}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {mode === "pixabay" ? "Nhập nhạc" : "Tải lên"}
        </Button>
      </div>
    </form>
  );
}
