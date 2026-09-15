"use client";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approveTimeline, requestChanges, submitForReview, withdrawReview } from "@/app/app/projects/[id]/review-actions";

export type ReviewPanelProps = {
  projectId: string;
  state: string;
  latestTimeline: { id: string; version: number } | null;
  approvedTimelineId: string | null;
  canEdit: boolean;
  canApprove: boolean;
  busy: boolean;
  /** Script has unsupported/unchecked scenes (or no check) → approval needs the logged override. */
  needsOverride: boolean;
  faithfulnessCounts: { supported: number; partial: number; unsupported: number; unchecked: number } | null;
  sensitiveTopic: boolean;
  reviews: Array<{ id: string; action: "submitted" | "approved" | "changes_requested" | "withdrawn"; note: string | null; timelineVersion: number | null; faithfulnessOverride: boolean; createdAt: string; actorName: string | null }>;
};

const ACTION_LABEL: Record<ReviewPanelProps["reviews"][number]["action"], string> = { submitted: "gửi duyệt", approved: "đã duyệt", changes_requested: "yêu cầu sửa", withdrawn: "rút lại" };

/** Approval flow UI (docs/PLAN.md §4.8): editor submits, publisher approves or requests changes; every step is logged. */
export function ReviewPanel(p: ReviewPanelProps) {
  const approvedIsLatest = Boolean(p.latestTimeline && p.approvedTimelineId === p.latestTimeline.id);
  const status =
    p.state === "in_review" ? { label: "Chờ duyệt", variant: "secondary" as const } : approvedIsLatest ? { label: p.state === "rendered" ? "Đã duyệt · đã kết xuất" : "Đã duyệt · chờ kết xuất", variant: "default" as const } : { label: "Bản nháp", variant: "outline" as const };
  const canSubmit = p.canEdit && p.latestTimeline && ["composed", "rendered", "approved"].includes(p.state) && !approvedIsLatest;
  const canDecide = p.canApprove && p.latestTimeline && ["composed", "in_review", "rendered"].includes(p.state) && !approvedIsLatest;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={status.variant}>{status.label}</Badge>
        {p.latestTimeline ? <span className="text-xs text-muted-foreground">timeline v{p.latestTimeline.version}</span> : null}
        {p.sensitiveTopic ? <Badge variant="destructive">chủ đề nhạy cảm</Badge> : null}
        {p.faithfulnessCounts ? (
          <span className="text-xs text-muted-foreground">
            kiểm chứng: {p.faithfulnessCounts.supported} ok
            {p.faithfulnessCounts.partial ? ` · ${p.faithfulnessCounts.partial} một phần` : ""}
            {p.faithfulnessCounts.unsupported + p.faithfulnessCounts.unchecked ? ` · ${p.faithfulnessCounts.unsupported + p.faithfulnessCounts.unchecked} không căn cứ` : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">chưa có kiểm chứng</span>
        )}
      </div>

      {canSubmit ? (
        <ActionForm action={submitForReview} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="projectId" value={p.projectId} />
          <input name="note" placeholder="Ghi chú cho publisher (tuỳ chọn)" className="h-8 min-w-60 flex-1 rounded-md border bg-background px-2 text-sm" />
          <Button type="submit" size="sm" variant="outline" disabled={p.busy}>
            Gửi duyệt v{p.latestTimeline?.version}
          </Button>
        </ActionForm>
      ) : null}
      {p.canEdit && p.state === "in_review" ? (
        <ActionForm action={withdrawReview}>
          <input type="hidden" name="projectId" value={p.projectId} />
          <Button type="submit" size="sm" variant="ghost" disabled={p.busy}>
            Rút lại
          </Button>
        </ActionForm>
      ) : null}

      {canDecide ? (
        <div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
          <ActionForm action={approveTimeline} className="space-y-2">
            <input type="hidden" name="projectId" value={p.projectId} />
            <input type="hidden" name="timelineId" value={p.latestTimeline?.id ?? ""} />
            <div className="text-xs font-medium">Duyệt v{p.latestTimeline?.version}</div>
            <Textarea name="note" rows={2} placeholder="Ghi chú (tuỳ chọn)" className="text-sm" />
            {p.needsOverride ? (
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" name="override" className="mt-0.5" /> Duyệt dù có cảnh không căn cứ / chưa kiểm chứng (được ghi log)
              </label>
            ) : null}
            <Button type="submit" size="sm" disabled={p.busy}>
              Duyệt
            </Button>
          </ActionForm>
          <ActionForm action={requestChanges} className="space-y-2">
            <input type="hidden" name="projectId" value={p.projectId} />
            <div className="text-xs font-medium">Trả lại để sửa</div>
            <Textarea name="note" rows={2} placeholder="Cần sửa gì?" className="text-sm" required />
            <Button type="submit" size="sm" variant="outline" disabled={p.busy}>
              Yêu cầu sửa
            </Button>
          </ActionForm>
        </div>
      ) : null}
      {!p.canApprove && p.state === "in_review" ? <p className="text-xs text-muted-foreground">Đang chờ publisher duyệt.</p> : null}

      {p.reviews.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {p.reviews.slice(0, 8).map((r) => (
            <li key={r.id}>
              <span className="text-foreground">{r.actorName ?? "?"}</span> {ACTION_LABEL[r.action]}
              {r.timelineVersion ? ` v${r.timelineVersion}` : ""} · {r.createdAt.slice(0, 16).replace("T", " ")}
              {r.faithfulnessOverride ? " · bỏ qua kiểm chứng" : ""}
              {r.note ? ` — ${r.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
