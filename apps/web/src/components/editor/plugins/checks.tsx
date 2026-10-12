"use client";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUILTIN_CHECKS, type Check } from "@/lib/media/editor-checks";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { definePlugin, type EditorPlugin } from "../core/plugin";
import { PanelHeader, SEVERITY_DOT, SEVERITY_LABEL } from "../shell/ui";

function ChecksPanel() {
  const ctx = useEditor();
  const issues = ctx.derived.issues;
  const open = issues.filter((i) => i.severity !== "info").length;
  const checks = ctx.plugins.contributions.checks;
  const passed = checks.filter((c) => !issues.some((i) => i.checkId === c.id));
  return (
    <div className="pb-4">
      <PanelHeader title="Kiểm tra" meta={open ? `${open} việc nên sửa` : "ổn"} />
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">Chạy lại sau mỗi thay đổi. Bấm một mục để tới đúng chỗ.</p>
      <ul className="space-y-1.5 px-2">
        {issues.map((i) => (
          <li key={i.id} className="rounded-lg border bg-card p-2.5">
            <button
              type="button"
              className="flex w-full items-start gap-2 text-left"
              onClick={() => {
                if (!i.sceneId) return;
                ctx.select({ sceneId: i.sceneId, shot: i.fix && "shot" in i.fix ? (i.fix.shot ?? 0) : 0 });
                ctx.player.seekScene(i.sceneId);
              }}
            >
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", SEVERITY_DOT[i.severity])} aria-label={SEVERITY_LABEL[i.severity]} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{i.title}</span>
                {i.detail ? <span className="block text-xs text-muted-foreground">{i.detail}</span> : null}
              </span>
            </button>
            {i.fix ? (
              <div className="mt-2 pl-4">
                <Button size="xs" disabled={ctx.pending.rewriting === i.sceneId} onClick={() => ctx.applyFix(i)}>
                  {ctx.pending.rewriting === i.sceneId ? "Claude đang viết…" : i.fix.label}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {passed.length ? <p className="px-3 pt-3 text-[11px] text-success">✓ {passed.map((c) => c.label.toLowerCase()).join(" · ")}</p> : null}
      {!checks.length ? <p className="px-3 text-xs text-muted-foreground">Workspace đã tắt mọi kiểm tra (bảng Tiện ích).</p> : null}
    </div>
  );
}

/** The "Kiểm tra" panel: every issue the check plugins find, with its one-click fix. */
export const checksPanelPlugin = definePlugin({
  id: "checks",
  name: "Bảng kiểm tra",
  description: "Danh sách việc cần sửa trước khi xuất, mỗi việc kèm cách sửa một chạm.",
  panels: [
    {
      id: "checks",
      title: "Kiểm tra",
      icon: CircleCheck,
      order: 40,
      badge: (c) => {
        const n = c.derived.issues.filter((i) => i.severity !== "info").length;
        return n ? { count: n, tone: "warn" } : null;
      },
      Component: ChecksPanel,
    },
  ],
});

const CHECK_DESCRIPTION: Record<string, string> = {
  "checks.faithfulness": "Cảnh không có căn cứ trong bài gốc; sửa bằng Claude viết lại theo bài.",
  "checks.duration": "Video dài hơn giới hạn của nền tảng có kênh trong workspace.",
  "checks.shot-hold": "Một hình đứng quá 5 s; tự thêm hình chưa dùng.",
  "checks.solid-shot": "Cảnh quay còn là nền màu tạm.",
  "checks.repeated-picture": "Một hình xuất hiện hai lần trong video.",
  "checks.faces": "Khuôn mặt bị cắt hoặc bị chữ che; căn khung tự động.",
  "checks.originality": "Quá nửa thời lượng, hoặc hơn 10 s liền, là video của người khác (luật nội dung nguyên bản của Meta).",
  "checks.hook-text": "Cảnh mở đầu không có chữ trên màn hình.",
  "checks.audio": "Âm thanh chưa trộn, không có nhạc nền.",
};

/** One plugin per built-in check, so a workspace can switch each off. */
export const checkPlugins: EditorPlugin[] = BUILTIN_CHECKS.map((check: Check) =>
  definePlugin({ id: check.id, name: `Kiểm tra: ${check.label.toLowerCase()}`, description: CHECK_DESCRIPTION[check.id] ?? check.label, checks: [check] }),
);
