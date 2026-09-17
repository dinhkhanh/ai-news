"use client";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ExportInfo } from "./types";

const RENDER_LABEL: Record<string, string> = { queued: "chờ", rendering: "đang kết xuất", post_processing: "hậu kỳ + QA", qa_failed: "QA không đạt", done: "xong", failed: "lỗi" };

/**
 * Render (export) without leaving the editor. With unsaved edits the button saves
 * first and renders the new version; the parent owns that sequence (`onExport`).
 * Progress shows in the page header (<PipelineStatus>), which also reloads the
 * page when the render ends, so the finished MP4 appears in the list below.
 */
export function ExportPanel({
  projectId,
  info,
  version,
  nextVersion,
  approved,
  dirty,
  canSave,
  disabled,
  busy,
  hint,
  working,
  onExport,
  onForce,
}: {
  projectId: string;
  info: ExportInfo;
  version: number;
  /** Version a save would create; rendered instead of `version` when `dirty`. */
  nextVersion: number;
  approved: boolean;
  dirty: boolean;
  /** Unsaved edits can only be exported from the latest version. */
  canSave: boolean;
  disabled: boolean;
  /** A pipeline step is running or a request is in flight: no new render of any kind. */
  busy: boolean;
  hint: string | null;
  working: boolean;
  onExport: (logoChannelId: string | null) => void;
  /** Render that version again with QA not gating the result (offered on a `qa_failed` row). */
  onForce: (render: ExportInfo["renders"][number]) => void;
}) {
  const [logo, setLogo] = useState(info.logoChannels.some((c) => c.id === info.defaultLogoChannelId) ? info.defaultLogoChannelId! : "");
  const saveFirst = dirty && canSave;
  const label = working ? (saveFirst ? "Đang lưu và gửi kết xuất…" : "Đang gửi kết xuất…") : saveFirst ? `Lưu v${nextVersion} và kết xuất` : approved ? `Kết xuất bản duyệt v${version}` : `Kết xuất thử v${version}`;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="export-logo">Kết xuất (xuất video)</Label>
        <span className="text-xs text-muted-foreground">
          hôm nay {info.quota.used}/{info.quota.limit} phút
        </span>
      </div>
      {info.logoChannels.length ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="export-logo">
          logo
          <select id="export-logo" value={logo} disabled={disabled || working} onChange={(e) => setLogo(e.target.value)} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground">
            <option value="">của bộ nhận diện</option>
            {info.logoChannels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.platformLabel}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Button type="button" className="w-full" variant={approved && !saveFirst ? "default" : "outline"} disabled={disabled || working} onClick={() => onExport(info.logoChannels.length ? logo || "kit" : null)}>
        {label}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        {hint ?? (saveFirst ? "Thay đổi chưa lưu sẽ được lưu thành phiên bản mới rồi kết xuất ngay phiên bản đó." : "1080×1920, 30 fps, −14 LUFS. Mất vài phút; tiến độ hiện ở đầu trang, bạn không cần rời trình chỉnh sửa.")}
        {!hint && (saveFirst || !approved) ? " Bản chưa duyệt chỉ là kết xuất thử, không đăng được." : ""}
      </p>
      {info.renders.length ? (
        <ul className="space-y-1 border-t pt-2 text-xs">
          {info.renders.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-1.5">
              <Badge variant={r.status === "done" ? "default" : r.status === "failed" || r.status === "qa_failed" ? "destructive" : "secondary"}>{RENDER_LABEL[r.status] ?? r.status}</Badge>
              <span className="text-muted-foreground">
                v{r.version ?? "?"} · {r.createdAt.slice(5, 16).replace("T", " ")} · logo {r.logoName}
              </span>
              {r.videoUrl ? (
                <a href={r.videoUrl} target="_blank" rel="noreferrer" className="underline">
                  tải / xem MP4
                </a>
              ) : null}
              {r.qaOverridden ? <Badge variant="destructive">QA bị bỏ qua</Badge> : null}
              {r.error ? <span className="w-full truncate text-destructive" title={r.error}>{r.error}</span> : null}
              {r.canForce ? (
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy || working} title="Kết xuất lại đúng phiên bản và logo này; kết quả QA vẫn được ghi lại nhưng không còn chặn bản kết xuất. Tính phút kết xuất như thường." onClick={() => onForce(r)}>
                  Kết xuất lại v{r.version ?? "?"}, bỏ qua QA
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Link href={`/app/projects/${projectId}`} className="block text-[11px] text-muted-foreground underline">
        Mọi bản kết xuất, ghim và đăng: trang dự án
      </Link>
    </div>
  );
}
