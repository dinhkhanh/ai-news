"use client";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cancelPublication, createPublication, retryPublication } from "@/app/app/projects/[id]/publish-actions";
import { PLATFORM_SPEC, type Platform, type PublishMetadata } from "@/lib/publish/platforms";

export type PublishChannel = { id: string; platform: Platform; name: string; granted: boolean; enabled: boolean; healthy: boolean; flagOn: boolean; /** The channel has a video logo of its own. */ hasLogo: boolean; defaults: PublishMetadata };
export type PublicationView = {
  id: string;
  platform: Platform;
  channelName: string;
  status: string;
  attempts: number;
  scheduledAt: string | null;
  publishedAt: string | null;
  platformUrl: string | null;
  privacy: string;
  aiDisclosure: boolean;
  error: string | null;
  analytics: { views: number | null; likes: number | null; comments: number | null; shares: number | null; pulledAt: string } | null;
  renderVersion: number | null;
  createdByName: string | null;
};

export const PUB_STATUS_LABEL: Record<string, string> = { draft: "nháp", scheduled: "chờ lịch", publishing: "đang tải lên", processing: "nền tảng đang xử lý", published: "đã đăng", failed: "lỗi", cancelled: "đã huỷ" };
export const PRIVACY_LABEL: Record<string, string> = { public: "Công khai", unlisted: "Không công khai (link)", private: "Riêng tư", PUBLIC_TO_EVERYONE: "Công khai", MUTUAL_FOLLOW_FRIENDS: "Bạn bè", FOLLOWER_OF_CREATOR: "Người theo dõi", SELF_ONLY: "Chỉ mình tôi" };

type Props = {
  projectId: string;
  render: { id: string; version: number | null; durationSec: number | null } | null;
  /** Finished renders of the approved version, newest first, with the channel whose logo each carries (null = the kit's logo). */
  renders: Array<{ id: string; logoChannelId: string | null; logoName: string }>;
  canPublish: boolean;
  schedulingOn: boolean;
  aiDisclosure: boolean;
  channels: PublishChannel[];
  publications: PublicationView[];
  quota: { used: number; limit: number };
};

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "");

/** Publishing UI (docs/PLAN.md §4.10): one form per granted channel with per-platform limits, schedule, disclosure; attempt list with status, link, analytics. */
export function PublishPanel(p: Props) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4 text-sm">
      {!p.render ? (
        <p className="text-muted-foreground">Chưa có bản kết xuất của phiên bản đã duyệt. Duyệt rồi kết xuất trước khi đăng.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge>bản kết xuất timeline v{p.render.version}</Badge>
          {p.render.durationSec ? <span className="text-xs text-muted-foreground">{p.render.durationSec.toFixed(0)} giây</span> : null}
          <span className="text-xs text-muted-foreground">
            Hôm nay đã dùng {p.quota.used}/{p.quota.limit} lượt đăng.
          </span>
        </div>
      )}
      {p.render && p.canPublish ? (
        <div className="flex flex-wrap gap-2">
          {p.channels.length === 0 ? <span className="text-muted-foreground">Workspace chưa có kênh nào. Nhờ admin kết nối kênh trong /admin/channels.</span> : null}
          {p.channels.map((c) => {
            const spec = PLATFORM_SPEC[c.platform];
            const blocked = !c.granted ? "chưa được cấp quyền" : !c.enabled ? "kênh tạm dừng" : !c.healthy ? "token lỗi" : !c.flagOn ? "nền tảng đang tắt" : p.render && p.render.durationSec != null && p.render.durationSec > spec.maxDurationSec ? `video dài hơn ${spec.maxDurationSec}s` : null;
            return (
              <Button key={c.id} size="sm" variant={open === c.id ? "default" : "outline"} disabled={Boolean(blocked)} title={blocked ?? ""} onClick={() => setOpen(open === c.id ? null : c.id)}>
                {spec.label} · {c.name}
                {blocked ? ` (${blocked})` : ""}
              </Button>
            );
          })}
        </div>
      ) : null}
      {p.render && p.canPublish && open
        ? (() => {
            const c = p.channels.find((x) => x.id === open)!;
            const spec = PLATFORM_SPEC[c.platform];
            // Logos belong to channels: publish the render made with this channel's logo when there is one.
            const own = p.renders.find((r) => r.logoChannelId === c.id);
            const chosen = own ?? p.renders[0] ?? null;
            return (
              <ActionForm key={c.id} action={createPublication} className="space-y-3 rounded-md border p-3">
                <input type="hidden" name="projectId" value={p.projectId} />
                <input type="hidden" name="channelId" value={c.id} />
                <input type="hidden" name="renderId" value={chosen?.id ?? p.render!.id} />
                {c.hasLogo && !own ? (
                  <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
                    Chưa có bản kết xuất mang logo của {c.name}: bản sẽ đăng mang logo “{chosen?.logoName ?? "bộ nhận diện"}”. Muốn đúng logo, kết xuất lại ở mục Kết xuất (chọn logo {c.name}) rồi quay lại đây.
                  </p>
                ) : own ? (
                  <p className="text-xs text-muted-foreground">Đăng bản kết xuất mang logo của {c.name}.</p>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  {spec.label} · {c.name} · giới hạn: {spec.titleMax ? `tiêu đề ${spec.titleMax}` : ""} {spec.descriptionMax ? `· mô tả ${spec.descriptionMax}` : ""} · {spec.hashtagMax} hashtag · ≤ {spec.maxDurationSec}s
                </div>
                {spec.titleMax ? (
                  <div className="space-y-1">
                    <Label htmlFor={`t-${c.id}`}>{c.platform === "tiktok" ? "Chú thích (kèm hashtag)" : "Tiêu đề"}</Label>
                    {c.platform === "tiktok" ? <Textarea id={`t-${c.id}`} name="title" rows={5} defaultValue={c.defaults.title} maxLength={spec.titleMax} /> : <Input id={`t-${c.id}`} name="title" defaultValue={c.defaults.title} maxLength={spec.titleMax} />}
                  </div>
                ) : (
                  <input type="hidden" name="title" value={c.defaults.title} />
                )}
                {spec.descriptionMax ? (
                  <div className="space-y-1">
                    <Label htmlFor={`d-${c.id}`}>{c.platform === "instagram" ? "Chú thích" : "Mô tả"}</Label>
                    <Textarea id={`d-${c.id}`} name="description" rows={6} defaultValue={c.defaults.description} maxLength={spec.descriptionMax} />
                  </div>
                ) : null}
                {c.platform !== "tiktok" ? (
                  <div className="space-y-1">
                    <Label htmlFor={`h-${c.id}`}>Hashtag (cách nhau bằng dấu cách)</Label>
                    <Input id={`h-${c.id}`} name="hashtags" defaultValue={c.defaults.hashtags.map((h) => `#${h}`).join(" ")} />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor={`p-${c.id}`}>Hiển thị</Label>
                    <select id={`p-${c.id}`} name="privacy" defaultValue={spec.privacy[0]} className="h-9 rounded-md border bg-background px-2 text-sm">
                      {spec.privacy.map((v) => (
                        <option key={v} value={v}>
                          {PRIVACY_LABEL[v] ?? v}
                        </option>
                      ))}
                    </select>
                  </div>
                  {p.schedulingOn ? (
                    <div className="space-y-1">
                      <Label htmlFor={`s-${c.id}`}>Lên lịch (giờ Việt Nam, để trống = đăng ngay)</Label>
                      <Input id={`s-${c.id}`} name="scheduledAt" type="datetime-local" />
                    </div>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="aiDisclosure" defaultChecked={p.aiDisclosure} /> Gắn nhãn nội dung có AI {spec.disclosureFlag ? "(cờ của nền tảng)" : "(dòng trong mô tả)"}
                  </label>
                </div>
                {c.platform === "tiktok" ? <p className="text-xs text-muted-foreground">Ứng dụng TikTok chưa qua kiểm duyệt chỉ đăng được ở chế độ “Chỉ mình tôi”; hệ thống tự hạ mức hiển thị nếu cần và ghi lại.</p> : null}
                <Button type="submit">{p.schedulingOn ? "Đăng / lên lịch" : "Đăng ngay"}</Button>
              </ActionForm>
            );
          })()
        : null}

      {p.publications.length ? (
        <div className="space-y-2">
          {p.publications.map((x) => (
            <div key={x.id} className="rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={x.status === "published" ? "default" : x.status === "failed" ? "destructive" : "secondary"}>{PUB_STATUS_LABEL[x.status] ?? x.status}</Badge>
                <span className="font-medium">
                  {PLATFORM_SPEC[x.platform].label} · {x.channelName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {x.renderVersion ? `timeline v${x.renderVersion} · ` : ""}
                  {PRIVACY_LABEL[x.privacy] ?? x.privacy}
                  {x.aiDisclosure ? " · nhãn AI" : ""}
                  {x.attempts > 1 ? ` · lần ${x.attempts}` : ""}
                  {x.status === "scheduled" && x.scheduledAt ? ` · lịch ${fmt(x.scheduledAt)}` : ""}
                  {x.publishedAt ? ` · đăng ${fmt(x.publishedAt)}` : ""}
                  {x.createdByName ? ` · ${x.createdByName}` : ""}
                </span>
                {x.platformUrl ? (
                  <a href={x.platformUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                    mở bài đăng
                  </a>
                ) : null}
                {x.status === "scheduled" ? (
                  <ActionForm action={cancelPublication}>
                    <input type="hidden" name="publicationId" value={x.id} />
                    <Button type="submit" size="sm" variant="ghost" className="h-7">
                      Huỷ
                    </Button>
                  </ActionForm>
                ) : null}
                {(x.status === "failed" || x.status === "cancelled") && p.canPublish ? (
                  <ActionForm action={retryPublication}>
                    <input type="hidden" name="publicationId" value={x.id} />
                    <Button type="submit" size="sm" variant="ghost" className="h-7">
                      Thử lại
                    </Button>
                  </ActionForm>
                ) : null}
              </div>
              {x.analytics ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {x.analytics.views != null ? `${x.analytics.views.toLocaleString("vi-VN")} lượt xem` : "chưa có lượt xem"}
                  {x.analytics.likes != null ? ` · ${x.analytics.likes.toLocaleString("vi-VN")} thích` : ""}
                  {x.analytics.comments != null ? ` · ${x.analytics.comments.toLocaleString("vi-VN")} bình luận` : ""}
                  {x.analytics.shares != null ? ` · ${x.analytics.shares.toLocaleString("vi-VN")} chia sẻ` : ""}
                  {` · cập nhật ${fmt(x.analytics.pulledAt)}`}
                </div>
              ) : null}
              {x.error ? <div className="mt-1 text-xs text-destructive">{x.error.slice(0, 300)}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
