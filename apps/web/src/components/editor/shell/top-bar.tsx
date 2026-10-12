"use client";
import Link from "next/link";
import { ChevronDown, ChevronLeft, Film, History, Redo2, RotateCcw, Save, Search, Undo2 } from "lucide-react";
import { PipelineStatus } from "@/components/pipeline-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { Kbd } from "./ui";

const KIND_LABEL: Record<string, string> = { built: "dựng", edited: "sửa", regenerated: "tạo lại" };

/** Header of the workspace: way back, title, versions, undo / redo, the Dựng ⇄ Xuất & duyệt switch, save and export. */
export function TopBar() {
  const ctx = useEditor();
  const { props } = ctx;
  const open = ctx.derived.issues.filter((i) => i.severity !== "info").length;
  const approved = props.approvedTimelineId === props.version.id;
  const oldVersion = !props.version.isLatest;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-card px-2 py-1.5 sm:px-3">
      <Button variant="ghost" size="icon-sm" render={<Link href={`/app/projects/${props.projectId}`} aria-label="Về trang dự án" />}>
        <ChevronLeft />
      </Button>
      <div className="min-w-0 max-w-[40vw] sm:max-w-xs">
        <div className="truncate text-[11px] text-muted-foreground">Trình dựng video</div>
        <div className="truncate text-sm font-semibold" title={props.projectTitle}>
          {props.projectTitle}
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="gap-1" aria-label="Phiên bản" />}>
          <span className="font-mono">v{props.version.version}</span>
          {approved ? <Badge variant="success" className="hidden sm:inline-flex">đã duyệt</Badge> : null}
          {oldVersion ? <Badge variant="secondary">chỉ đọc</Badge> : null}
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] min-w-72 overflow-y-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Phiên bản · {props.versions.length}</DropdownMenuLabel>
            {props.versions.map((v) => (
              <DropdownMenuItem key={v.id} render={<Link href={`/app/projects/${props.projectId}/edit?t=${v.version}`} />} className={cn("flex-col items-start gap-0.5", v.id === props.version.id && "bg-muted")}>
                <span className="text-xs font-medium">
                  v{v.version} · {KIND_LABEL[v.kind] ?? v.kind}
                  {v.id === props.approvedTimelineId ? " · đã duyệt" : ""}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {v.createdAt.slice(0, 16).replace("T", " ")}
                  {v.createdByName ? ` · ${v.createdByName}` : ""}
                  {v.changes.length ? ` · ${v.changes.slice(0, 2).join(" · ")}${v.changes.length > 2 ? ` · +${v.changes.length - 2}` : ""}` : ""}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center">
        <Button variant="ghost" size="icon-sm" disabled={!ctx.history.canUndo} onClick={ctx.history.undo} aria-label="Hoàn tác (⌘Z)" title={ctx.history.undoLabel ? `Hoàn tác: ${ctx.history.undoLabel} (⌘Z)` : "Hoàn tác (⌘Z)"}>
          <Undo2 />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={!ctx.history.canRedo} onClick={ctx.history.redo} aria-label="Làm lại (⇧⌘Z)" title={ctx.history.redoLabel ? `Làm lại: ${ctx.history.redoLabel} (⇧⌘Z)` : "Làm lại (⇧⌘Z)"}>
          <Redo2 />
        </Button>
      </div>

      <nav aria-label="Chế độ" className="order-last flex w-full justify-center rounded-lg border bg-muted/50 p-0.5 sm:order-none sm:mx-auto sm:w-auto">
        {(["edit", "deliver"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={ctx.ui.mode === m}
            onClick={() => ctx.ui.setMode(m)}
            className={cn("flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground sm:flex-none pointer-coarse:min-h-10", ctx.ui.mode === m && "bg-card text-foreground shadow-xs")}
          >
            {m === "edit" ? "Dựng" : "Xuất & duyệt"}
            {m === "deliver" && open ? <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] text-amber-700 dark:text-amber-300">{open}</span> : null}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
        {props.status ? <PipelineStatus initial={props.status} variant="inline" canRun={props.canEdit} className="hidden md:flex" /> : null}
        <Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground md:inline-flex" onClick={() => ctx.ui.setPaletteOpen(true)}>
          <Search /> Lệnh <Kbd>⌘K</Kbd>
        </Button>
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => ctx.ui.setPaletteOpen(true)} aria-label="Tìm lệnh">
          <Search />
        </Button>
        {oldVersion && props.canEdit ? (
          <Button size="sm" variant="outline" disabled={ctx.busy || ctx.pending.requesting} onClick={ctx.services.restore} title={`Lưu nội dung v${props.version.version} thành phiên bản mới nhất`}>
            <History /> <span className="hidden sm:inline">Khôi phục thành v{props.versions[0].version + 1}</span>
          </Button>
        ) : null}
        {ctx.canSave ? (
          <>
            {ctx.dirty ? (
              <Button variant="ghost" size="icon-sm" onClick={ctx.reset} aria-label="Huỷ mọi thay đổi chưa lưu" title="Huỷ mọi thay đổi chưa lưu">
                <RotateCcw />
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={!ctx.dirty || ctx.pending.saving || ctx.busy} onClick={ctx.services.save} title="Lưu thành phiên bản mới (⌘S)">
              <Save />
              <span className="hidden sm:inline">{ctx.pending.saving ? "Đang lưu…" : ctx.dirty ? `Lưu v${props.version.version + 1}` : "Đã lưu"}</span>
              {ctx.dirty ? <span className="size-1.5 rounded-full bg-amber-500" aria-label="có thay đổi chưa lưu" /> : null}
            </Button>
          </>
        ) : null}
        {props.canEdit ? (
          <Button size="sm" onClick={() => ctx.ui.setMode("deliver")} disabled={ctx.ui.mode === "deliver"}>
            <Film /> <span className="hidden sm:inline">Xuất video</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
