"use client";
import { useState } from "react";
import { Clapperboard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MIN_CONTENT_WORDS, videoLinkKind } from "@/lib/video-source";

const SITE_NAME: Array<[RegExp, string]> = [
  [/youtu\.?be/i, "YouTube"],
  [/tiktok/i, "TikTok"],
  [/facebook|fb\.watch/i, "Facebook"],
  [/vimeo/i, "Vimeo"],
  [/dailymotion/i, "Dailymotion"],
];

/**
 * The source part of the new-project form: a link (a news article, or a video page, recognised as it is typed)
 * or content typed in. Posts `mode` = `link` | `text` with `url`, or `title` + `text` (see `createProject`).
 */
export function NewProjectSource() {
  const [mode, setMode] = useState<"link" | "text">("link");
  const [url, setUrl] = useState("");
  const [words, setWords] = useState(0);
  const video = mode === "link" && url.trim() ? videoLinkKind(url) : null;
  const site = video ? (SITE_NAME.find(([re]) => re.test(url))?.[1] ?? "video") : null;

  return (
    <div className="space-y-2">
      <input type="hidden" name="mode" value={mode} />
      <div role="radiogroup" aria-label="Nguồn nội dung" className="inline-flex h-8 items-stretch rounded-xl bg-sidebar pointer-coarse:h-10">
        {(
          [
            ["link", "Dán link"],
            ["text", "Tự nhập nội dung"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              "inline-flex items-center rounded-[9px] px-3 text-[0.9375rem] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
              mode === value && "bg-card font-medium text-foreground shadow-xs ring-1 ring-sidebar-border",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "link" ? (
        <div className="space-y-1">
          <Label htmlFor="url">Link bài báo hoặc video</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="url"
              name="url"
              type="url"
              inputMode="url"
              placeholder="https://vnexpress.net/… · https://www.tiktok.com/@…/video/…"
              required
              autoComplete="off"
              className="flex-1"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" className="sm:shrink-0">
              <Plus data-icon="inline-start" /> Tạo dự án
            </Button>
          </div>
          <p className={cn("flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground", video && "text-foreground")} aria-live="polite">
            {video ? (
              <>
                <Clapperboard className="size-3.5 shrink-0" aria-hidden />
                Link video {site}: hệ thống tải video và lấy tiêu đề + chú thích; bạn viết nội dung, mọi cảnh dùng chính video này.
              </>
            ) : (
              "Bài báo: hệ thống lấy nội dung bài. Link YouTube, TikTok, Facebook reels… được nhận ra là video."
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="new-title">Tiêu đề (không bắt buộc)</Label>
            <Input id="new-title" name="title" autoComplete="off" placeholder="Để trống: lấy dòng đầu của nội dung" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-text">Nội dung</Label>
            <Textarea
              id="new-text"
              name="text"
              rows={10}
              required
              className="text-sm leading-relaxed"
              placeholder="Dán hoặc viết nội dung của bạn. Có thể kèm chỉ dẫn cách viết kịch bản."
              onChange={(e) => setWords(e.target.value.trim() ? e.target.value.trim().split(/\s+/).length : 0)}
            />
            <p className="text-xs text-muted-foreground">
              {words} từ · cần ít nhất {MIN_CONTENT_WORDS.text}. Nội dung được xác nhận ngay; bước tiếp theo là viết kịch bản.
            </p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" className="w-full sm:w-auto">
              <Plus data-icon="inline-start" /> Tạo dự án
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
