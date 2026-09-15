"use client";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addComment, toggleCommentResolved } from "@/app/app/projects/[id]/review-actions";
import { cn } from "@/lib/utils";
import type { CommentRow } from "./types";

type Props = {
  projectId: string;
  timelineId: string;
  comments: CommentRow[];
  canComment: boolean;
  selectedSceneId: string | null;
  /** Current player position in ms (captured on demand). */
  currentMs: () => number;
  onJump: (atMs: number | null, sceneId: string | null) => void;
};

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 100))}`;

/** Review comments anchored to a scene and/or a timestamp (docs/PLAN.md §4.7 "Comments"). */
export function CommentsPanel({ projectId, timelineId, comments, canComment, selectedSceneId, currentMs, onJump }: Props) {
  const [showResolved, setShowResolved] = useState(false);
  const [pinScene, setPinScene] = useState(true);
  const [pinnedMs, setPinnedMs] = useState<number | null>(null);
  const visible = comments.filter((c) => showResolved || !c.resolvedAt);
  const open = comments.filter((c) => !c.resolvedAt).length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {open} bình luận mở{comments.length > open ? ` · ${comments.length - open} đã xong` : ""}
        </span>
        {comments.length > open ? (
          <button type="button" className="underline" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "ẩn đã xong" : "hiện đã xong"}
          </button>
        ) : null}
      </div>
      {canComment ? (
        <ActionForm action={addComment} className="space-y-2" resetOnSuccess>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="timelineId" value={timelineId} />
          <input type="hidden" name="sceneId" value={pinScene && selectedSceneId ? selectedSceneId : ""} />
          <input type="hidden" name="atMs" value={pinnedMs ?? ""} />
          <Textarea name="body" rows={3} placeholder="Nhận xét cho người dựng / publisher…" className="text-sm" required />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={pinScene} onChange={(e) => setPinScene(e.target.checked)} /> gắn cảnh {selectedSceneId ?? "—"}
            </label>
            <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => setPinnedMs(pinnedMs == null ? Math.round(currentMs()) : null)}>
              {pinnedMs == null ? "ghim thời điểm hiện tại" : `tại ${fmt(pinnedMs)} ✕`}
            </button>
            <Button type="submit" size="sm" className="ml-auto">
              Gửi
            </Button>
          </div>
        </ActionForm>
      ) : null}
      <div className="space-y-2">
        {visible.length === 0 ? <p className="text-xs text-muted-foreground">Chưa có bình luận.</p> : null}
        {visible.map((c) => (
          <div key={c.id} className={cn("rounded-md border p-2 text-sm", c.resolvedAt && "opacity-60")}>
            <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{c.authorName ?? "?"}</span>
              <span>{c.createdAt.slice(0, 16).replace("T", " ")}</span>
              {c.sceneId ? (
                <button type="button" onClick={() => onJump(c.atMs, c.sceneId)} className="rounded border px-1 hover:bg-muted">
                  {c.sceneId}
                </button>
              ) : null}
              {c.atMs != null ? (
                <button type="button" onClick={() => onJump(c.atMs, c.sceneId)} className="rounded border px-1 hover:bg-muted">
                  {fmt(c.atMs)}
                </button>
              ) : null}
              {c.resolvedAt ? <Badge variant="outline">xong</Badge> : null}
              {canComment ? (
                <ActionForm action={toggleCommentResolved} className="ml-auto">
                  <input type="hidden" name="commentId" value={c.id} />
                  <button type="submit" className="underline">
                    {c.resolvedAt ? "mở lại" : "đánh dấu xong"}
                  </button>
                </ActionForm>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap leading-relaxed">{c.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
