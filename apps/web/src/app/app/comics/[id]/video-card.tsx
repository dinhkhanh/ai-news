"use client";
import { useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { VoiceSelect } from "@/components/voice-select";
import type { VoiceOption } from "@/lib/media/tts";
import { makeComicVideo } from "../video-actions";

export type ComicVideoRow = { id: string; title: string; state: string; busy: boolean; createdAt: string; current: boolean };

const STATE: Record<string, string> = { scripted: "đang dựng", composed: "đã dựng", in_review: "đang duyệt", approved: "đã duyệt", rendered: "đã kết xuất", published: "đã đăng", failed: "lỗi" };
const MOTION_OVERHEAD_SEC = 5;
const fmt = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)} phút ${Math.round(sec % 60)} giây` : `${Math.round(sec)} giây`);

/**
 * "Làm video" (docs/COMIC.md §11.1, M4) on the Xuất tab: pages, episodes, narrator voice, brand kit, channel logo
 * and music, with a live length estimate against the platforms' limits; then the videos already made from the comic.
 */
export function VideoCard({
  comicId,
  writer,
  pageSecs,
  undrawn,
  limits,
  voices,
  kits,
  logoChannels,
  videos,
}: {
  comicId: string;
  writer: boolean;
  /** Seconds of video each page gives (`pageSeconds`). */
  pageSecs: number[];
  undrawn: number;
  limits: { label: string; maxSec: number }[];
  voices: VoiceOption[];
  kits: { id: string; name: string; isDefault: boolean }[];
  logoChannels: { id: string; name: string; platform: string }[];
  videos: ComicVideoRow[];
}) {
  const pages = pageSecs.length;
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(pages);
  const [split, setSplit] = useState(false);
  const [per, setPer] = useState(Math.min(3, Math.max(1, pages)));
  // An emptied number field reads as 0 / NaN: fall back to the whole comic, one page per episode.
  const lo = Math.min(Math.max(1, from || 1), pages);
  const hi = Math.min(Math.max(lo, to || pages), pages);
  const size = split ? Math.max(1, per || 1) : pages;
  const ranges: [number, number][] = [];
  for (let p = lo; p <= hi; p += size) ranges.push([p, Math.min(hi, p + size - 1)]);
  const secs = ranges.map(([a, b]) => pageSecs.slice(a - 1, b).reduce((x, y) => x + y, 0) + MOTION_OVERHEAD_SEC);
  const longest = Math.max(0, ...secs);
  const over = limits.filter((l) => longest > l.maxSec);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Làm video (truyện động)</CardTitle>
        <CardDescription>
          Video dọc 9:16: mỗi lời thoại một cảnh trên khung của nó, nhân vật đọc bằng giọng riêng (đặt ở mục Nhân vật), lời dẫn do người dẫn truyện đọc, phụ đề theo từng chữ. Không gọi mô hình viết kịch bản; chỉ tốn tiền giọng đọc. Video dùng bản hiện tại của truyện; sửa truyện xong thì làm video lại.
        </CardDescription>
      </CardHeader>
      {writer && pages ? (
        <CardContent>
          <ActionForm action={makeComicVideo} className="space-y-4">
            <input type="hidden" name="comicId" value={comicId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="mv-from">Từ trang</Label>
                  <Input id="mv-from" name="from" type="number" min={1} max={pages} value={from} onChange={(e) => setFrom(Number(e.target.value))} className="w-24" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mv-to">đến trang</Label>
                  <Input id="mv-to" name="to" type="number" min={1} max={pages} value={to} onChange={(e) => setTo(Number(e.target.value))} className="w-24" />
                </div>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex min-h-10 items-center gap-2 text-sm">
                  <input type="checkbox" name="split" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Chia thành tập
                </label>
                {split ? (
                  <div className="space-y-1">
                    <Label htmlFor="mv-per">trang mỗi tập</Label>
                    <Input id="mv-per" name="perEpisode" type="number" min={1} max={pages} value={per} onChange={(e) => setPer(Number(e.target.value))} className="w-24" />
                  </div>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="mv-voice">Người dẫn truyện</Label>
                <VoiceSelect id="mv-voice" voices={voices} value={null} className="w-full" title="Đọc lời dẫn và lời của nhân vật chưa có giọng riêng." />
              </div>
              {kits.length > 1 ? (
                <div className="space-y-1">
                  <Label htmlFor="mv-kit">Bộ nhận diện</Label>
                  <NativeSelect id="mv-kit" name="brandKitId" defaultValue="" className="w-full">
                    <option value="">Bộ mặc định</option>
                    {kits.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                        {k.isDefault ? " (mặc định)" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              {logoChannels.length ? (
                <div className="space-y-1">
                  <Label htmlFor="mv-logo">Logo kênh</Label>
                  <NativeSelect id="mv-logo" name="logoChannelId" defaultValue={logoChannels.length === 1 ? logoChannels[0].id : ""} className="w-full">
                    <option value="">Logo của bộ nhận diện</option>
                    {logoChannels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.platform}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="music" defaultChecked /> Nhạc nền (chọn theo độ dài video)
              </label>
            </div>
            <div className="space-y-1 text-sm" aria-live="polite">
              <p>
                {ranges.length > 1 ? `${ranges.length} tập, ` : ""}khoảng {ranges.length > 1 ? `${fmt(Math.min(...secs))} – ${fmt(longest)} mỗi tập` : fmt(longest)} (ước lượng; độ dài thật có sau khi đọc giọng).
              </p>
              {over.length ? (
                <p className="text-amber-700 dark:text-amber-400">
                  Dài hơn giới hạn của {over.map((l) => `${l.label} (${l.maxSec} giây)`).join(", ")}: chọn ít trang hơn hoặc chia thành tập.
                </p>
              ) : null}
              {undrawn ? <p className="text-muted-foreground">{undrawn} khung chưa vẽ sẽ bị bỏ qua.</p> : null}
            </div>
            <Button type="submit">Làm video</Button>
          </ActionForm>
        </CardContent>
      ) : null}
      {videos.length ? (
        <CardContent className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium text-muted-foreground">Video đã làm từ truyện này</h3>
          <ul className="space-y-1.5">
            {videos.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Link href={`/app/projects/${v.id}`} className="min-w-0 truncate hover:underline">
                  {v.title}
                </Link>
                <span className="flex items-center gap-1.5">
                  {!v.current ? <Badge variant="outline" title="Truyện đã được sửa sau khi làm video này: làm video lại để có bản mới">bản cũ</Badge> : null}
                  <Badge variant={v.state === "failed" ? "destructive" : v.busy ? "secondary" : "success"}>{v.busy ? "đang dựng" : (STATE[v.state] ?? v.state)}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
