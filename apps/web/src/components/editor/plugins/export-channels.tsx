"use client";
import { useState } from "react";
import { Film } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VideoButton } from "@/components/video-dialog";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { Section } from "../shell/ui";

const RENDER_LABEL: Record<string, string> = { queued: "chờ", rendering: "đang kết xuất", post_processing: "hậu kỳ + QA", qa_failed: "QA không đạt", done: "xong", failed: "lỗi" };
const MAX_LOGOS = 6;

/**
 * One render per channel (each with that channel's logo), queued back to back by the server; "Bộ nhận diện" is the
 * kit's own logo. With unsaved edits the editor saves a new version first and renders that one.
 */
function ChannelExport() {
  const ctx = useEditor();
  const info = ctx.props.exportInfo;
  const [picked, setPicked] = useState<string[]>(() => (info.logoChannels.length ? [info.logoChannels.find((c) => c.id === info.defaultLogoChannelId)?.id ?? info.logoChannels[0].id] : ["kit"]));
  const targets = [...info.logoChannels.map((c) => ({ id: c.id, name: c.name, spec: `${c.platformLabel} · logo kênh` })), { id: "kit", name: "Bộ nhận diện", spec: "logo của bộ nhận diện" }];
  const saveFirst = ctx.dirty && ctx.canSave;
  const approved = ctx.props.approvedTimelineId === ctx.props.version.id && !ctx.dirty;
  const version = saveFirst ? ctx.props.versions[0].version + 1 : ctx.props.version.version;
  const disabled = Boolean(ctx.exportHint) || ctx.pending.saving || ctx.pending.exporting || picked.length === 0;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_LOGOS ? p : [...p, id]));

  return (
    <div className="space-y-5">
      <Section title="Xuất video" aside={<span className="text-[11px] text-muted-foreground">hôm nay {info.quota.used}/{info.quota.limit} phút</span>}>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs text-muted-foreground">Mỗi kênh một bản, logo theo kênh</legend>
          {targets.map((t) => {
            const on = picked.includes(t.id);
            return (
              <label key={t.id} className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border p-2", on && "border-primary/50 bg-primary/5")}>
                <input type="checkbox" checked={on} onChange={() => toggle(t.id)} className="size-4 accent-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{t.spec}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <Button className="w-full" variant={approved ? "default" : "outline"} disabled={disabled} onClick={() => ctx.services.exportVideo(picked)}>
          <Film />
          {ctx.pending.exporting ? (saveFirst ? "Đang lưu và gửi…" : "Đang gửi…") : `${saveFirst ? `Lưu v${version} và xuất` : `Xuất v${version}`}${picked.length > 1 ? ` · ${picked.length} bản` : ""}`}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          {ctx.exportHint ?? `1080×1920, 30 fps, −14 LUFS; các bản chạy lần lượt, tiến độ ở đầu trang.${approved ? "" : " Bản chưa duyệt chỉ là kết xuất thử, không đăng được."}`}
        </p>
      </Section>
      {info.renders.length ? (
        <Section title="Các lần xuất">
          <ul className="space-y-1.5">
            {info.renders.map((r) => (
              <li key={r.id} className="space-y-1 rounded-lg border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono">v{r.version ?? "?"}</span>
                  <span className="min-w-0 flex-1 truncate">{r.logoName}</span>
                  <Badge variant={r.status === "done" ? "success" : r.status === "failed" || r.status === "qa_failed" ? "destructive" : "secondary"}>{RENDER_LABEL[r.status] ?? r.status}</Badge>
                  {r.videoUrl ? <VideoButton src={r.videoUrl} downloadSrc={r.downloadUrl} title={`Kết xuất v${r.version ?? "?"}`} description={`logo ${r.logoName} · ${r.createdAt.slice(0, 16).replace("T", " ")}`} /> : null}
                </div>
                <div className="text-muted-foreground">
                  {r.createdAt.slice(5, 16).replace("T", " ")}
                  {r.qaOverridden ? " · QA bị bỏ qua" : ""}
                </div>
                {r.error ? <div className="truncate text-destructive" title={r.error}>{r.error}</div> : null}
                {r.canForce ? (
                  <Button size="xs" variant="outline" disabled={ctx.busy || ctx.pending.exporting} title="Kết xuất lại đúng phiên bản và logo này; QA vẫn được ghi nhưng không chặn. Tính phút như thường." onClick={() => ctx.services.forceRender(r)}>
                    Xuất lại, bỏ qua QA
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** Export target: the workspace's channels (one render per logo) plus the kit's own logo. */
export const exportChannelsPlugin = definePlugin({
  id: "export.channels",
  name: "Xuất theo kênh",
  description: "Xuất một bản cho mỗi kênh đã chọn (logo của kênh), chạy lần lượt; lịch sử kết xuất và xuất lại bỏ qua QA.",
  required: true,
  exporters: [{ id: "channels", label: "Xuất theo kênh", order: 10, Component: ChannelExport }],
  commands: [
    {
      id: "export.go",
      title: (c) => `Xuất video v${c.dirty && c.canSave ? c.props.versions[0].version + 1 : c.props.version.version}`,
      group: "Tệp",
      when: (c) => c.props.canEdit && !c.exportHint,
      run: (c) => c.ui.setMode("deliver"),
    },
  ],
});
