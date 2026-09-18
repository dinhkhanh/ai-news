"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Download, Play, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// The player (and its stylesheet) load on first open only.
const VideoPlayer = dynamic(() => import("./video-player").then((m) => m.VideoPlayer), {
  ssr: false,
  loading: () => <div className="aspect-[9/16] w-full animate-pulse bg-muted" />,
});

type Props = {
  src: string;
  title: string;
  /** One line under the title: version, logo, duration… */
  description?: string;
  poster?: string | null;
  label?: string;
  size?: "xs" | "sm" | "default";
  variant?: "default" | "outline" | "ghost";
  className?: string;
};

/**
 * "Xem MP4" button that opens the render in a modal player on the same page,
 * portrait 9:16, sized to the viewport. The download link stays beside it for
 * anyone who does want the file.
 */
export function VideoButton({ src, title, description, poster, label = "Xem MP4", size = "xs", variant = "outline", className }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <span className={cn("inline-flex items-center gap-1", className)}>
        <Button type="button" size={size} variant={variant} onClick={() => setOpen(true)}>
          <Play /> {label}
        </Button>
        <Button size={size === "default" ? "icon" : size === "sm" ? "icon-sm" : "icon-xs"} variant="ghost" title="Tải MP4 về" aria-label="Tải MP4 về" render={<a href={src} target="_blank" rel="noreferrer" download />}>
          <Download />
        </Button>
      </span>
      <DialogContent showCloseButton={false} className="w-[min(100vw-1rem,440px,calc(92vh*9/16))] max-w-none grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden bg-card p-0">
        <div className="flex items-start gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">{title}</DialogTitle>
            <DialogDescription className="truncate text-xs">{description ?? "Phát trực tiếp từ kho; chỉ tải phần đang xem."}</DialogDescription>
          </div>
          <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Đóng" />}>
            <XIcon />
          </DialogClose>
        </div>
        <div className="w-full overflow-hidden">{open ? <VideoPlayer src={src} poster={poster} autoPlay /> : null}</div>
      </DialogContent>
    </Dialog>
  );
}
