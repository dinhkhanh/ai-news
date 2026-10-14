"use client";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTimecode } from "@/lib/media/visual-plan";
import { parseSourceSegment, SOURCE_VIDEO_MAX_SEC } from "@/lib/video-source";

/**
 * "Đoạn video dùng: từ … đến …" for a video project's source, chosen before anything is downloaded (new-project form,
 * "Tải lại video"). Posts `sourceStart` / `sourceEnd` as typed; blank = the whole video. The server reads them with
 * the same `parseSourceSegment`, so the hint under the fields says exactly what will happen.
 */
export function SourceSegmentFields({ defaultStart = "", defaultEnd = "", durationSec = null }: { defaultStart?: string; defaultEnd?: string; durationSec?: number | null }) {
  const id = useId();
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const r = parseSourceSegment(start, end);
  const max = `${SOURCE_VIDEO_MAX_SEC / 60} phút`;
  const hint = !r.ok
    ? null
    : r.segment.startSec === null && r.segment.endSec === null
      ? `Để trống: cả video${durationSec ? ` (${formatTimecode(durationSec)})` : ""}, tối đa ${max}.`
      : r.segment.endSec === null
        ? `Chỉ tải và dùng từ ${formatTimecode(r.segment.startSec ?? 0)} đến hết video (tối đa ${max}).`
        : `Chỉ tải và dùng ${formatTimecode(r.segment.startSec ?? 0)} → ${formatTimecode(r.segment.endSec)} (${formatTimecode(r.segment.endSec - (r.segment.startSec ?? 0))}).`;

  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Đoạn video dùng</legend>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor={`${id}-start`} className="font-normal text-muted-foreground">
          Từ
        </Label>
        <Input id={`${id}-start`} name="sourceStart" value={start} onChange={(e) => setStart(e.target.value)} placeholder="0:00" autoComplete="off" spellCheck={false} aria-invalid={!r.ok || undefined} className="h-8 w-24 tabular-nums" />
        <Label htmlFor={`${id}-end`} className="font-normal text-muted-foreground">
          đến
        </Label>
        <Input id={`${id}-end`} name="sourceEnd" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="hết video" autoComplete="off" spellCheck={false} aria-invalid={!r.ok || undefined} className="h-8 w-28 tabular-nums" />
      </div>
      <p className={r.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} aria-live="polite">
        {r.ok ? hint : r.error}
      </p>
    </fieldset>
  );
}
