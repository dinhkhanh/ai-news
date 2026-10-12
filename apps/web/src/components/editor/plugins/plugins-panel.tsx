"use client";
import { useState } from "react";
import { Plug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useEditor } from "../core/context";
import { definePlugin, type EditorPlugin } from "../core/plugin";
import { PanelHeader } from "../shell/ui";

const CONTRIBUTES: Array<[keyof EditorPlugin, string]> = [
  ["panels", "bảng"],
  ["inspector", "thẻ chi tiết"],
  ["tracks", "hàng dòng thời gian"],
  ["markers", "ghim"],
  ["overlays", "lớp xem trước"],
  ["checks", "kiểm tra"],
  ["commands", "lệnh"],
  ["mediaSources", "bộ lọc thư viện"],
  ["exporters", "đích xuất"],
];

function PluginsPanel() {
  const ctx = useEditor();
  const [saving, setSaving] = useState(false);
  const can = ctx.props.plugins.canManage;
  const off = new Set(ctx.plugins.disabled);
  const toggle = async (p: EditorPlugin, on: boolean) => {
    setSaving(true);
    try {
      await ctx.services.setPlugins(on ? ctx.plugins.disabled.filter((id) => id !== p.id) : [...ctx.plugins.disabled, p.id]);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="pb-4">
      <PanelHeader title="Tiện ích" meta={`${ctx.plugins.active.length}/${ctx.plugins.all.length} đang bật`} />
      <p className="px-3 pb-3 text-[11px] text-muted-foreground">{can ? "Bật / tắt cho cả workspace. Tiện ích bắt buộc luôn bật." : "Chỉ quản trị workspace mới bật / tắt được."}</p>
      <ul className="space-y-1.5 px-2">
        {ctx.plugins.all.map((p) => {
          const parts = CONTRIBUTES.filter(([k]) => (p[k] as unknown[] | undefined)?.length).map(([k, label]) => `${(p[k] as unknown[]).length} ${label}`);
          return (
            <li key={p.id} className="rounded-lg border bg-card p-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {p.name}
                    {p.required ? <Badge variant="outline">bắt buộc</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {p.id} · {parts.join(" · ")}
                  </p>
                </div>
                <Switch checked={p.required || !off.has(p.id)} disabled={!can || p.required || saving} onCheckedChange={(on) => void toggle(p, on)} aria-label={`${p.name}: bật / tắt`} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The plugin list itself: what each contributes, switched per workspace by its admins. */
export const pluginsPanelPlugin = definePlugin({
  id: "core.plugins",
  name: "Quản lý tiện ích",
  description: "Danh sách tiện ích của trình dựng; quản trị workspace bật / tắt cho cả workspace.",
  required: true,
  panels: [{ id: "plugins", title: "Tiện ích", icon: Plug, order: 90, Component: PluginsPanel }],
});
