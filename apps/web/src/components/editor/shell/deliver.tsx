"use client";
import Link from "next/link";
import { Save } from "lucide-react";
import type { Timeline } from "@ai-news/video/schema";
import { ReviewPanel } from "@/components/review-panel";
import { Button } from "@/components/ui/button";
import { sceneShots } from "@/lib/media/editor";
import type { Issue } from "@/lib/media/editor-checks";
import { cn } from "@/lib/utils";
import { useEditor, usePlayerRef } from "../core/context";
import { usePlayerSync } from "../core/use-player-sync";
import { Preview } from "../preview";
import { Note, Section, SEVERITY_DOT, SEVERITY_LABEL, Thumb, timecode } from "./ui";

function IssueRow({ issue }: { issue: Issue }) {
  const ctx = useEditor();
  const open = () => {
    ctx.ui.setMode("edit");
    if (issue.sceneId) {
      ctx.select({ sceneId: issue.sceneId });
      ctx.player.seekScene(issue.sceneId);
    }
  };
  return (
    <li className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", SEVERITY_DOT[issue.severity])} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{issue.title}</div>
          {issue.detail ? <div className="text-xs text-muted-foreground">{issue.detail}</div> : null}
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">{SEVERITY_LABEL[issue.severity]}</span>
      </div>
      {issue.fix || issue.sceneId ? (
        <div className="flex flex-wrap gap-1.5 pl-4">
          {issue.fix ? (
            <Button size="xs" disabled={ctx.pending.rewriting === issue.sceneId} onClick={() => ctx.applyFix(issue)}>
              {ctx.pending.rewriting === issue.sceneId ? "Claude đang viết…" : issue.fix.label}
            </Button>
          ) : null}
          {issue.sceneId ? (
            <Button size="xs" variant="outline" onClick={open}>
              Mở trong trình dựng
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Left: what the checks found, faithfulness first. */
function Preflight() {
  const ctx = useEditor();
  const issues = ctx.derived.issues;
  const blocking = issues.filter((i) => i.severity !== "info");
  const checks = ctx.plugins.contributions.checks;
  const failing = new Set(blocking.map((i) => i.checkId));
  const passed = checks.filter((c) => !failing.has(c.id) && !issues.some((i) => i.checkId === c.id));
  const counts = ctx.props.faithfulnessCounts;
  const total = counts ? counts.supported + counts.partial + counts.unsupported + counts.unchecked : 0;
  const ratio = checks.length ? (checks.length - failing.size) / checks.length : 1;
  return (
    <section aria-labelledby="preflight" className="space-y-4 overflow-y-auto border-r bg-card p-4">
      <div className="flex items-center gap-3">
        <div aria-hidden className="relative flex size-14 items-center justify-center rounded-full" style={{ background: `conic-gradient(var(--success) 0 ${ratio * 100}%, var(--muted) ${ratio * 100}% 100%)` }}>
          <span className="flex size-11 items-center justify-center rounded-full bg-card text-sm font-bold">
            {checks.length - failing.size}/{checks.length}
          </span>
        </div>
        <div>
          <h2 id="preflight" className="text-base font-semibold">
            Trước khi xuất
          </h2>
          <p className="text-xs text-muted-foreground">{blocking.length ? `${blocking.length} việc nên sửa. Vẫn xuất được; người duyệt thấy danh sách này.` : "Không còn việc gì cần sửa."}</p>
        </div>
      </div>
      {counts && total ? (
        <Section title="Kiểm chứng với bài gốc">
          <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
            <span className="bg-success" style={{ flex: counts.supported }} />
            <span className="bg-amber-500" style={{ flex: counts.partial }} />
            <span className="bg-destructive" style={{ flex: counts.unsupported }} />
            <span className="bg-muted-foreground/40" style={{ flex: counts.unchecked }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {counts.supported} có căn cứ · {counts.partial} một phần · {counts.unsupported} không căn cứ · {counts.unchecked} chưa kiểm
          </p>
        </Section>
      ) : null}
      <ul className="space-y-2">
        {issues.map((i) => (
          <IssueRow key={i.id} issue={i} />
        ))}
      </ul>
      {passed.length ? (
        <details className="border-t pt-3 text-xs">
          <summary className="cursor-pointer text-success">✓ {passed.length} mục đạt</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {passed.map((c) => (
              <li key={c.id}>{c.label}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** Middle: the final preview with the Player's own controls, and the cover frame picker. */
function FinalPreview({ timeline }: { timeline: Timeline }) {
  const ctx = useEditor();
  const playerRef = usePlayerRef();
  usePlayerSync();
  const cover = ctx.doc.coverAtSec;
  const candidates = ctx.built.timings.map((t, i) => ({ id: t.id, atSec: Math.round((t.atSec + 0.6) * 10) / 10, visual: sceneShots(ctx.doc.scenes[i]).at(0) }));
  const setCover = (sec: number | null) => ctx.update(sec == null ? "Ảnh bìa tự động" : `Ảnh bìa tại ${sec.toFixed(1)} s`, (d) => ({ ...d, coverAtSec: sec }));
  return (
    <section aria-label="Xem lần cuối" className="flex min-w-0 flex-col items-center gap-4 overflow-y-auto bg-neutral-950 p-4 text-neutral-100">
      <div className="w-full max-w-[300px]">
        <Preview ref={playerRef} timeline={timeline} />
      </div>
      <div className="w-full max-w-md space-y-2">
        <div className="flex items-center justify-between text-xs text-neutral-400">
          <span>Ảnh bìa: {cover != null ? `tại ${timecode(cover)}` : "tự động (~1,2 s)"}</span>
          <span className="flex gap-1">
            <Button size="xs" variant="outline" disabled={ctx.readOnly} onClick={() => setCover(Math.round(ctx.player.nowSec() * 10) / 10)}>
              Khung đang xem
            </Button>
            {cover != null ? (
              <Button size="xs" variant="ghost" disabled={ctx.readOnly} onClick={() => setCover(null)}>
                Tự động
              </Button>
            ) : null}
          </span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {candidates.map((c) => {
            const t = c.visual ? ctx.derived.thumb(c.visual) : { src: null, video: false };
            const on = cover != null && Math.abs(cover - c.atSec) < 0.05;
            return (
              <button key={c.id} type="button" disabled={ctx.readOnly} onClick={() => (setCover(c.atSec), ctx.player.seek(c.atSec))} aria-label={`Ảnh bìa tại ${timecode(c.atSec)}`} aria-pressed={on} className="flex shrink-0 flex-col items-center gap-1">
                <span className={cn("block h-[78px] w-11 overflow-hidden rounded-md bg-neutral-800", on ? "ring-2 ring-sky-400" : "ring-1 ring-white/10")}>
                  <Thumb src={t.src} video={t.video} />
                </span>
                <span className="font-mono text-[10px] text-neutral-400">{c.id}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Right: export targets (exporter plugins), the save note, and review. */
function DeliverSide() {
  const ctx = useEditor();
  const { props } = ctx;
  return (
    <section aria-label="Xuất và duyệt" className="space-y-5 overflow-y-auto border-l bg-card p-4">
      {ctx.canSave && ctx.dirty ? (
        <div className="space-y-2 rounded-lg border p-3">
          <label htmlFor="version-note" className="text-xs text-muted-foreground">
            Ghi chú cho v{props.version.version + 1} (tuỳ chọn)
          </label>
          <input id="version-note" value={ctx.ui.note} onChange={(e) => ctx.ui.setNote(e.target.value)} maxLength={200} placeholder="vd: đã sửa s5 theo bài gốc" className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40" />
          <Button size="sm" variant="outline" disabled={ctx.pending.saving || ctx.busy} onClick={ctx.services.save}>
            <Save /> {ctx.pending.saving ? "Đang lưu…" : `Lưu v${props.version.version + 1}`}
          </Button>
          {props.approvedTimelineId === props.version.id ? <p className="text-[11px] text-muted-foreground">Phiên bản này đã được duyệt: lưu sẽ huỷ duyệt.</p> : null}
        </div>
      ) : null}
      {props.canEdit ? ctx.plugins.contributions.exporters.map((x) => <x.Component key={x.id} />) : null}
      <Section title="Duyệt">
        <ReviewPanel
          projectId={props.projectId}
          state={props.projectState}
          latestTimeline={props.versions[0] ? { id: props.versions[0].id, version: props.versions[0].version } : null}
          approvedTimelineId={props.approvedTimelineId}
          canEdit={props.canEdit}
          canApprove={props.canApprove}
          busy={ctx.busy || ctx.dirty}
          needsOverride={!props.faithfulnessCounts || props.faithfulnessCounts.unsupported + props.faithfulnessCounts.unchecked > 0}
          faithfulnessCounts={props.faithfulnessCounts}
          sensitiveTopic={props.sensitiveTopic}
          reviews={props.reviews}
        />
        {ctx.dirty ? <Note>Lưu thay đổi trước khi gửi duyệt / duyệt.</Note> : null}
        <Link href={`/app/projects/${props.projectId}`} className="inline-flex min-h-8 items-center text-xs underline">
          Trang dự án: đăng, kịch bản, bài gốc
        </Link>
      </Section>
    </section>
  );
}

/** "Xuất & duyệt": pre-flight checks · final preview · export and review, side by side (stacked on phones). */
export function Deliver({ timeline }: { timeline: Timeline }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)_minmax(320px,420px)] lg:overflow-hidden">
      <div className="order-2 min-h-0 lg:order-none lg:contents">
        <Preflight />
      </div>
      <div className="order-1 min-h-0 lg:order-none lg:contents">
        <FinalPreview timeline={timeline} />
      </div>
      <div className="order-3 min-h-0 lg:order-none lg:contents">
        <DeliverSide />
      </div>
    </div>
  );
}
