"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { createUploadUrl, registerWebCapture } from "@/app/app/projects/[id]/edit/actions";
import { Button } from "@/components/ui/button";
import { openTabCapture, recordYouTube, tabCaptureSupported } from "@/lib/media/tab-capture";
import { SHOT_SEC, type PendingCapture } from "@/lib/media/visual-plan";
import type { VisualOption } from "./types";

type Props = {
  projectId: string;
  captures: PendingCapture[];
  disabled: boolean;
  /** A capture is stored: add it to the options and place its segments into the planned scenes. */
  onCaptured: (capture: PendingCapture, option: VisualOption, url: string) => void;
};

/**
 * YouTube videos the build picked but the server could not download (YouTube
 * blocks datacenter IPs). One click records them in this tab through YouTube's
 * embedded player, on the editor's own connection (`lib/media/tab-capture.ts`).
 */
export function WebCapturePanel({ projectId, captures, disabled, onCaptured }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [label, setLabel] = useState("");
  const [done, setDone] = useState<Record<string, "ok" | string>>({});
  const todo = captures.filter((c) => done[c.videoId] !== "ok");
  const support = tabCaptureSupported();
  if (captures.length === 0) return null;

  const run = () => {
    const box = boxRef.current;
    if (!box || running) return;
    // getDisplayMedia needs the click's user activation: nothing may be awaited before it.
    const opening = openTabCapture(box);
    setRunning(true);
    void (async () => {
      let session: Awaited<typeof opening> | null = null;
      try {
        session = await opening;
        for (const [i, c] of todo.entries()) {
          const head = `(${i + 1}/${todo.length}) ${c.title.slice(0, 50)}`;
          try {
            const durationSec = c.segments * SHOT_SEC;
            const blob = await recordYouTube(session, box, { videoId: c.videoId, startSec: c.startSec, durationSec }, (s) => setLabel(`${head}: ${s}`));
            setLabel(`${head}: đang tải lên và chuyển mã…`);
            const ext = blob.type === "video/mp4" ? "mp4" : "webm";
            const ticket = await createUploadUrl({ projectId, filename: `yt-${c.videoId}.${ext}`, contentType: blob.type, sizeBytes: blob.size });
            if (!ticket.ok) throw new Error(ticket.message);
            const put = await fetch(ticket.url, { method: "PUT", body: blob, headers: { "Content-Type": blob.type } }).catch(() => null);
            if (!put?.ok) throw new Error(put ? `tải lên thất bại (HTTP ${put.status})` : "tải lên thất bại (CORS của bucket R2?)");
            const res = await registerWebCapture({ projectId, key: ticket.key, contentType: blob.type, capture: { videoId: c.videoId, url: c.url, title: c.title, uploader: c.uploader, thumbnailUrl: c.thumbnailUrl, startSec: c.startSec, durationSec } });
            if (!res.ok) throw new Error(res.message);
            onCaptured(c, res.option, res.url);
            setDone((d) => ({ ...d, [c.videoId]: "ok" }));
          } catch (e) {
            const msg = e instanceof Error ? e.message : "lỗi không rõ";
            setDone((d) => ({ ...d, [c.videoId]: msg }));
            toast.error(`${c.title.slice(0, 40)}: ${msg}`);
            if (session.track.readyState !== "live") break;
          }
        }
      } catch (e) {
        toast.error(e instanceof Error && e.name !== "NotAllowedError" ? e.message : "Bạn chưa cho phép chia sẻ thẻ này.");
      } finally {
        session?.close();
        setRunning(false);
        setLabel("");
      }
    })();
  };

  return (
    <section className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Video YouTube cùng tin: máy chủ bị chặn, ghi bằng trình duyệt của bạn</h2>
          <p className="text-xs text-muted-foreground">
            {todo.length} video · bấm nút, chọn <b>cho phép chia sẻ thẻ này</b>, rồi để yên thẻ cho tới khi xong (ghi theo thời gian thực). Clip sẽ thay các shot stock/AI ở cuối cảnh đã định; xem lại rồi bấm Lưu.
          </p>
        </div>
        <Button type="button" size="sm" disabled={disabled || running || todo.length === 0 || !support.ok} onClick={run} title={support.reason ?? undefined}>
          {running ? "Đang ghi…" : `Ghi ${todo.length} video từ trình duyệt`}
        </Button>
      </div>
      {!support.ok ? <p className="text-xs text-destructive">Không ghi được ở đây: {support.reason}.</p> : null}
      <ul className="space-y-1 text-xs">
        {captures.map((c) => (
          <li key={c.videoId} className="flex flex-wrap items-center gap-2">
            <a href={c.url} target="_blank" rel="noreferrer" className="max-w-[28rem] truncate underline">
              {c.title}
            </a>
            <span className="text-muted-foreground">
              {c.uploader ?? "YouTube"} · {c.startSec}–{c.startSec + c.segments * SHOT_SEC} s → {c.scenes.map((s) => `${s.sceneId}×${s.segments}`).join(", ")}
            </span>
            {done[c.videoId] === "ok" ? <span className="text-emerald-600">đã ghi</span> : done[c.videoId] ? <span className="text-destructive">{done[c.videoId]}</span> : null}
          </li>
        ))}
      </ul>
      {/* Recording stage: fills the viewport while running so the player is as large (= as sharp) as the screen allows. */}
      <div className={running ? "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black" : "hidden"}>
        <div ref={boxRef} className="relative aspect-video bg-black" style={{ width: "min(100vw, calc((100vh - 3rem) * 16 / 9))" }} />
        <p className="h-6 text-xs text-white/80">{label}</p>
      </div>
    </section>
  );
}
