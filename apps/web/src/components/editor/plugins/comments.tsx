"use client";
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { addComment, toggleCommentResolved } from "@/app/app/projects/[id]/review-actions";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { PanelHeader, timecode } from "../shell/ui";

function CommentsPanel() {
  const ctx = useEditor();
  const { comments, canEdit, projectId, version } = ctx.props;
  const [showResolved, setShowResolved] = useState(false);
  const [pinScene, setPinScene] = useState(true);
  const open = comments.filter((c) => !c.resolvedAt).length;
  const visible = comments.filter((c) => showResolved || !c.resolvedAt);
  const sceneId = ctx.selection.sceneId;
  const at = ctx.ui.commentAtMs;
  const jump = (atMs: number | null, s: string | null) => {
    if (s) ctx.select({ sceneId: s });
    if (atMs != null) ctx.player.seek(atMs / 1000);
    else if (s) ctx.player.seekScene(s);
  };
  return (
    <div className="space-y-3 pb-4">
      <PanelHeader title="Bình luận" meta={`${open} mở`}>
        {comments.length > open ? (
          <Button size="xs" variant="ghost" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "ẩn đã xong" : `+${comments.length - open} đã xong`}
          </Button>
        ) : null}
      </PanelHeader>
      {canEdit ? (
        <ActionForm action={addComment} className="space-y-2 px-3" resetOnSuccess>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="timelineId" value={version.id} />
          <input type="hidden" name="sceneId" value={pinScene && sceneId ? sceneId : ""} />
          <input type="hidden" name="atMs" value={at ?? ""} />
          <Textarea name="body" rows={3} placeholder="Nhận xét cho người dựng / người duyệt…" className="text-sm" required aria-label="Bình luận mới" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex min-h-8 items-center gap-1.5">
              <input type="checkbox" checked={pinScene} onChange={(e) => setPinScene(e.target.checked)} /> gắn {sceneId ?? "—"}
            </label>
            <Button type="button" size="xs" variant="outline" onClick={() => ctx.ui.setCommentAtMs(at == null ? Math.round(ctx.player.nowSec() * 1000) : null)}>
              {at == null ? "ghim thời điểm đang xem" : `tại ${timecode(at / 1000)} ✕`}
            </Button>
            <Button type="submit" size="sm" className="ml-auto">
              Gửi
            </Button>
          </div>
        </ActionForm>
      ) : null}
      <ul className="space-y-2 px-2">
        {visible.length === 0 ? <li className="px-1 text-xs text-muted-foreground">Chưa có bình luận.</li> : null}
        {visible.map((c) => (
          <li key={c.id} className={cn("rounded-lg border bg-card p-2.5 text-sm", c.resolvedAt && "opacity-60")}>
            <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{c.authorName ?? "?"}</span>
              <span>{c.createdAt.slice(5, 16).replace("T", " ")}</span>
              {c.sceneId || c.atMs != null ? (
                <button type="button" className="rounded px-1 font-mono text-primary hover:bg-primary/10" onClick={() => jump(c.atMs, c.sceneId)}>
                  {[c.sceneId, c.atMs != null ? timecode(c.atMs / 1000) : null].filter(Boolean).join(" · ")}
                </button>
              ) : null}
              {canEdit ? (
                <ActionForm action={toggleCommentResolved} className="ml-auto">
                  <input type="hidden" name="commentId" value={c.id} />
                  <Button type="submit" size="xs" variant="ghost">
                    {c.resolvedAt ? "mở lại" : "đã xong"}
                  </Button>
                </ActionForm>
              ) : null}
            </div>
            <p className="leading-relaxed whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Review comments pinned to a scene and a moment, shown on the timeline ruler. */
export const commentsPlugin = definePlugin({
  id: "comments",
  name: "Bình luận",
  description: "Bình luận gắn cảnh và thời điểm; ghim hiện trên thước dòng thời gian; phím C để bình luận tại khung đang xem.",
  panels: [
    {
      id: "comments",
      title: "Bình luận",
      icon: MessageSquare,
      order: 50,
      badge: (c) => {
        const n = c.props.comments.filter((x) => !x.resolvedAt).length;
        return n ? { count: n, tone: "info" } : null;
      },
      Component: CommentsPanel,
    },
  ],
  markers: [
    {
      id: "comments",
      items: (c) =>
        c.props.comments
          .filter((x) => !x.resolvedAt && x.atMs != null)
          .map((x) => ({ id: `comment:${x.id}`, atSec: x.atMs! / 1000, label: `${x.authorName ?? "?"}: ${x.body.slice(0, 80)}`, tone: "accent" as const, glyph: "•", onSelect: () => (c.ui.setPanel("comments"), c.player.seek(x.atMs! / 1000)) })),
    },
  ],
  commands: [
    {
      id: "comments.here",
      title: () => "Bình luận tại khung đang xem",
      group: "Cả video",
      keys: "C",
      shortcut: { match: (e) => e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey && !e.altKey },
      when: (c) => c.props.canEdit,
      run: (c) => {
        c.ui.setCommentAtMs(Math.round(c.player.nowSec() * 1000));
        c.ui.setPanel("comments");
      },
    },
  ],
});
