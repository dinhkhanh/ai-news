import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { ScriptReview } from "@/components/script-review";
import { TimelineSummary, type BuildJson } from "@/components/timeline-summary";
import type { Timeline } from "@ai-news/video/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StoredFaithfulness, StoredScript } from "@/lib/llm/schemas";
import { DURATION_PRESETS, SCRIPT_TONES } from "@/lib/prompts/defaults";
import { busyIsStale, busyStep } from "@/lib/project-state";
import { presignGet } from "@/lib/r2";
import { displayHost } from "@/lib/url";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { dailyLimit, usedToday } from "@/lib/quota";
import { confirmArticle, deleteProject, pasteArticle, pinRender, refetchArticle, requestAssets, requestRender, requestScript } from "./actions";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  created: "Đang tải bài",
  fetched: "Đã lấy bài",
  scripted: "Đã có kịch bản",
  composed: "Đã dựng timeline",
  rendered: "Đã kết xuất",
  failed: "Lỗi",
};
const RENDER_LABEL: Record<string, string> = { queued: "chờ", rendering: "đang kết xuất", post_processing: "hậu kỳ + QA", qa_failed: "QA không đạt", done: "xong", failed: "lỗi" };

function PresetFields({ durationSec, tone }: { durationSec: number; tone: string }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="durationSec">Thời lượng</Label>
        <select id="durationSec" name="durationSec" defaultValue={String(durationSec)} className="h-9 rounded-md border bg-background px-2 text-sm">
          {DURATION_PRESETS.map((d) => (
            <option key={d} value={d}>
              {d} giây
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tone">Giọng điệu</Label>
        <select id="tone" name="tone" defaultValue={tone} className="h-9 rounded-md border bg-background px-2 text-sm">
          {SCRIPT_TONES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.vi} · {t.en}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string; t?: string; duplicate?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ws = await requireWorkspace();
  const writer = canWrite(ws);

  const data = await withOrgContext(ws, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!project) return null;
    const article = await tx.query.articles.findFirst({ where: eq(schema.articles.projectId, id), orderBy: desc(schema.articles.createdAt) });
    const scripts = await tx.query.scripts.findMany({ where: eq(schema.scripts.projectId, id), orderBy: desc(schema.scripts.version) });
    const timelines = await tx.query.timelines.findMany({ where: eq(schema.timelines.projectId, id), orderBy: desc(schema.timelines.version) });
    const renders = await tx.query.renders.findMany({ where: eq(schema.renders.projectId, id), orderBy: desc(schema.renders.createdAt) });
    return { project, article, scripts, timelines, renders };
  });
  if (!data) notFound();
  const { project, article, scripts, timelines, renders } = data;
  const selectedTimeline = timelines.find((t) => String(t.version) === sp.t) ?? timelines[0] ?? null;
  const timelineJson = selectedTimeline ? (selectedTimeline.json as unknown as Timeline) : null;
  const sign = async (key: string | null | undefined, ttl = 900) => {
    if (!key) return null;
    try {
      return await presignGet(key, ttl);
    } catch {
      return null;
    }
  };
  const imageUrls: Record<string, string> = {};
  for (const sc of timelineJson?.scenes ?? []) {
    if (sc.visual.kind === "image" && !imageUrls[sc.visual.src]) {
      const u = await sign(sc.visual.src);
      if (u) imageUrls[sc.visual.src] = u;
    }
  }
  const mixUrl = await sign(timelineJson?.audio.mixSrc);
  const renderLinks = new Map<string, { video: string | null; cover: string | null }>();
  for (const r of renders.slice(0, 10)) renderLinks.set(r.id, { video: r.status === "done" ? await sign(r.outputPath, 3600) : null, cover: await sign(r.coverPath) });
  const [renderLimit, renderUsed] = writer ? await Promise.all([dailyLimit(ws.userId, "render_minutes"), usedToday(ws.userId, "render_minutes")]) : [0, 0];
  const busy = Boolean(busyStep(project));
  const stale = busyIsStale(project);
  const selected = scripts.find((s) => String(s.version) === sp.v) ?? scripts[0] ?? null;
  let screenshotUrl: string | null = null;
  if (article?.screenshotPath) {
    try {
      screenshotUrl = await presignGet(article.screenshotPath, 900);
    } catch {
      screenshotUrl = null;
    }
  }
  const flags = article?.flags ?? {};
  const flagNotes = [
    flags.paywall ? "Bài có tường phí: nội dung có thể bị cắt, hãy kiểm tra hoặc dán thủ công." : null,
    flags.liveBlog ? "Đây là bài tường thuật trực tiếp: nội dung thay đổi liên tục, nên chọn một mốc thời gian." : null,
    flags.videoOnly ? "Trang chủ yếu là video, ít chữ để dựng kịch bản." : null,
    flags.short ? "Bài rất ngắn; kịch bản sẽ hạn chế." : null,
  ].filter(Boolean) as string[];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <AutoRefresh active={busy} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            <Link href="/app" className="underline">
              Dự án
            </Link>{" "}
            / {displayHost(project.url)}
          </div>
          <h1 className="truncate text-xl font-semibold tracking-tight">{project.title ?? project.url}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={project.state === "failed" ? "destructive" : project.state === "scripted" ? "default" : "secondary"}>{STATE_LABEL[project.state] ?? project.state}</Badge>
            {busy ? <Badge variant="outline">đang chạy: {project.busyStep}…</Badge> : null}
            {stale ? <Badge variant="destructive">bước {project.busyStep} không phản hồi, có thể chạy lại</Badge> : null}
            <Badge variant="outline">{project.language === "vi" ? "Tiếng Việt" : "English"}</Badge>
            {project.sensitiveTopic ? <Badge variant="destructive">chủ đề nhạy cảm → cần publisher duyệt</Badge> : null}
            <a href={project.url} target="_blank" rel="noreferrer" className="text-muted-foreground underline">
              mở bài gốc
            </a>
          </div>
        </div>
        {writer ? (
          <ActionForm action={deleteProject}>
            <input type="hidden" name="projectId" value={project.id} />
            <Button type="submit" size="sm" variant="ghost" className="text-destructive" disabled={busy}>
              Xoá dự án
            </Button>
          </ActionForm>
        ) : null}
      </div>

      {sp.duplicate ? <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">Bài này đã có dự án trong workspace; bạn đang xem dự án đó.</p> : null}
      {project.lastError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <span className="font-medium">Lỗi:</span> {project.lastError}
        </p>
      ) : null}
      {flagNotes.map((n) => (
        <p key={n} className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          {n}
        </p>
      ))}

      {/* ---------------- Article ---------------- */}
      {!article ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{busy ? "Đang lấy bài báo…" : "Chưa lấy được bài báo"}</CardTitle>
            <CardDescription>
              {busy
                ? "Cloudflare Browser Rendering → HTTP → Firecrawl. Trang tự làm mới."
                : "Thử lấy lại, dùng Firecrawl, hoặc dán nội dung bài thủ công bên dưới."}
            </CardDescription>
          </CardHeader>
          {!busy && writer ? <CardContent>{fallbackForms(project.id)}</CardContent> : null}
        </Card>
      ) : !article.confirmedAt ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Xác nhận nội dung bài báo</CardTitle>
            <CardDescription>
              Lấy bằng {article.fetchMethod} · {article.wordCount} từ · {article.siteName ?? displayHost(article.canonicalUrl)}
              {article.author ? ` · ${article.author}` : ""}
              {article.publishedAt ? ` · ${article.publishedAt.toISOString().slice(0, 10)}` : ""}. Sửa nếu cần rồi xác nhận; kịch bản chỉ được tạo từ văn bản đã xác nhận.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {article.images.length ? (
              <div className="flex gap-2 overflow-x-auto">
                {article.images.slice(0, 6).map((im) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={im.url} src={im.url} alt={im.alt ?? ""} className="h-24 rounded border object-cover" loading="lazy" />
                ))}
              </div>
            ) : null}
            <ActionForm action={confirmArticle} className="space-y-3">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor="title">Tiêu đề</Label>
                  <Input id="title" name="title" defaultValue={article.title ?? ""} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="language">Ngôn ngữ</Label>
                  <select id="language" name="language" defaultValue={project.language} className="h-9 rounded-md border bg-background px-2 text-sm">
                    <option value="vi">Tiếng Việt</option>
                    <option value="en">English</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="text">Nội dung</Label>
                <Textarea id="text" name="text" rows={18} defaultValue={article.text} className="text-sm leading-relaxed" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">{writer ? refetchButtons(project.id, busy) : null}</div>
                <Button type="submit" disabled={!writer || busy}>
                  Xác nhận văn bản
                </Button>
              </div>
            </ActionForm>
            {writer ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Dán nội dung thủ công</summary><div className="mt-2">{pasteForm(project.id, busy)}</div></details> : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- Script ---------------- */}
      {article?.confirmedAt ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Kịch bản</CardTitle>
                <CardDescription>
                  Claude Opus 5 viết kịch bản từ bài đã xác nhận, rồi kiểm chứng từng cảnh. Mỗi lần tạo là một phiên bản mới.
                </CardDescription>
              </div>
              {writer ? (
                <ActionForm action={requestScript} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="projectId" value={project.id} />
                  <PresetFields durationSec={project.durationSec} tone={project.tone} />
                  <Button type="submit" disabled={busy}>
                    {scripts.length ? "Tạo phiên bản mới" : "Tạo kịch bản"}
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {project.busyStep === "script" ? <p className="text-sm text-muted-foreground">Đang viết kịch bản và kiểm chứng… thường mất 1–3 phút. Trang tự làm mới.</p> : null}
            {scripts.length > 1 ? (
              <div className="flex flex-wrap gap-1 text-xs">
                {scripts.map((s) => (
                  <Link
                    key={s.id}
                    href={`/app/projects/${project.id}?v=${s.version}`}
                    className={`rounded-full border px-2 py-0.5 ${selected?.id === s.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                  >
                    v{s.version}
                  </Link>
                ))}
              </div>
            ) : null}
            {selected ? (
              <ScriptReview
                article={{ title: article.title, text: article.text, siteName: article.siteName, url: article.canonicalUrl, screenshotUrl }}
                script={selected.scenesJson as unknown as StoredScript}
                faithfulness={selected.faithfulnessJson && "scenes" in selected.faithfulnessJson ? (selected.faithfulnessJson as unknown as StoredFaithfulness) : null}
                meta={{ version: selected.version, createdAt: selected.createdAt.toISOString(), costUsd: selected.costUsd, inputTokens: selected.inputTokens, outputTokens: selected.outputTokens }}
              />
            ) : !busy ? (
              <p className="text-sm text-muted-foreground">Chưa có kịch bản. Chọn thời lượng và giọng điệu rồi bấm “Tạo kịch bản”.</p>
            ) : null}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Văn bản đã xác nhận · sửa và xác nhận lại</summary>
              <ActionForm action={confirmArticle} className="mt-2 space-y-2">
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="language" value={project.language} />
                <Input name="title" defaultValue={article.title ?? ""} />
                <Textarea name="text" rows={12} defaultValue={article.text} className="text-sm" />
                <div className="flex justify-between gap-2">
                  <div className="flex gap-2">{writer ? refetchButtons(project.id, busy) : null}</div>
                  <Button type="submit" size="sm" variant="outline" disabled={!writer || busy}>
                    Lưu và xác nhận lại
                  </Button>
                </div>
              </ActionForm>
            </details>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- Assets + timeline (phase 3) ---------------- */}
      {scripts.length ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Dựng video</CardTitle>
                <CardDescription>Lời đọc Google TTS + mốc từ, B-roll Pexels/Pixabay do Haiku xếp hạng (hoặc ảnh bài), nhạc nền, trộn âm −16 LUFS, rồi timeline. Mỗi lần dựng là một phiên bản mới.</CardDescription>
              </div>
              {writer ? (
                <ActionForm action={requestAssets} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="scriptId" value={selected?.id ?? ""} />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" name="skipStock" /> bỏ qua stock
                  </label>
                  <Button type="submit" disabled={busy}>
                    {timelines.length ? `Dựng lại từ kịch bản v${selected?.version ?? scripts[0].version}` : `Dựng từ kịch bản v${selected?.version ?? scripts[0].version}`}
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {project.busyStep === "assets" ? <p className="text-sm text-muted-foreground">Đang tổng hợp giọng đọc, tìm B-roll, trộn âm… thường mất 2–4 phút. Trang tự làm mới.</p> : null}
            {timelines.length > 1 ? (
              <div className="flex flex-wrap gap-1 text-xs">
                {timelines.map((t) => (
                  <Link key={t.id} href={`/app/projects/${project.id}?v=${sp.v ?? ""}&t=${t.version}`} className={`rounded-full border px-2 py-0.5 ${selectedTimeline?.id === t.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                    timeline v{t.version}
                  </Link>
                ))}
              </div>
            ) : null}
            {timelineJson && selectedTimeline ? (
              <>
                <TimelineSummary timeline={timelineJson} build={selectedTimeline.buildJson as BuildJson} imageUrls={imageUrls} mixUrl={mixUrl} />
                {writer ? (
                  <ActionForm action={requestRender} className="flex flex-wrap items-center gap-3 border-t pt-3">
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="timelineId" value={selectedTimeline.id} />
                    <Button type="submit" disabled={busy}>
                      Kết xuất timeline v{selectedTimeline.version}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Remotion Lambda → chuẩn hoá −14 LUFS → QA. Hôm nay đã dùng {renderUsed}/{renderLimit} phút kết xuất.
                    </span>
                  </ActionForm>
                ) : null}
              </>
            ) : !busy ? (
              <p className="text-sm text-muted-foreground">Chưa có timeline. Bấm “Dựng” để tạo lời đọc, B-roll và nhạc từ kịch bản đã chọn.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- Renders ---------------- */}
      {renders.length || project.busyStep === "render" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kết xuất</CardTitle>
            <CardDescription>1080×1920, 30 fps, H.264 CRF 18, −14 LUFS. Bản ghim không bao giờ hết hạn; bản khác giữ 12 tháng.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {project.busyStep === "render" ? <p className="text-sm text-muted-foreground">Đang kết xuất trên Remotion Lambda… 1–3 phút. Trang tự làm mới.</p> : null}
            {renders.slice(0, 10).map((r) => {
              const links = renderLinks.get(r.id);
              const checks = (r.qaJson as { checks?: Record<string, { ok: boolean; expected?: unknown; actual?: unknown }> } | null)?.checks ?? {};
              return (
                <div key={r.id} className="flex gap-3 rounded-md border p-2 text-sm">
                  <div className="h-28 w-16 shrink-0 overflow-hidden rounded bg-muted">
                    {links?.cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={links.cover} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={r.status === "done" ? "default" : r.status === "failed" || r.status === "qa_failed" ? "destructive" : "secondary"}>{RENDER_LABEL[r.status] ?? r.status}</Badge>
                      <span className="text-xs text-muted-foreground">
                        timeline v{r.timelineVersion} · {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                        {r.durationSec ? ` · ${Number(r.durationSec).toFixed(1)} s` : ""}
                        {r.costUsd ? ` · $${Number(r.costUsd).toFixed(3)}` : ""}
                        {r.renderSeconds ? ` · ${Number(r.renderSeconds).toFixed(0)} s render` : ""}
                      </span>
                      {r.pinned ? <Badge variant="outline">đã ghim</Badge> : null}
                    </div>
                    <div className="flex flex-wrap gap-1 text-xs">
                      {Object.entries(checks).map(([k, c]) => (
                        <Badge key={k} variant={c.ok ? "outline" : "destructive"}>
                          {k}
                          {c.ok ? "" : `: ${String(c.actual)}`}
                        </Badge>
                      ))}
                    </div>
                    {r.error ? <div className="text-xs text-destructive">{r.error.slice(0, 300)}</div> : null}
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      {links?.video ? (
                        <a href={links.video} target="_blank" rel="noreferrer" className="underline">
                          tải / xem MP4
                        </a>
                      ) : null}
                      {writer && r.status === "done" ? (
                        <ActionForm action={pinRender}>
                          <input type="hidden" name="renderId" value={r.id} />
                          <Button type="submit" size="sm" variant="ghost">
                            {r.pinned ? "Bỏ ghim" : "Ghim (giữ vĩnh viễn)"}
                          </Button>
                        </ActionForm>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function refetchButtons(projectId: string, busy: boolean) {
  return (
    <>
      {(["browser_rendering", "http", "firecrawl"] as const).map((m) => (
        <ActionForm key={m} action={refetchArticle}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="method" value={m} />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            Lấy lại: {m === "browser_rendering" ? "Browser" : m === "http" ? "HTTP" : "Firecrawl"}
          </Button>
        </ActionForm>
      ))}
    </>
  );
}

function pasteForm(projectId: string, busy: boolean) {
  return (
    <ActionForm action={pasteArticle} className="space-y-2">
      <input type="hidden" name="projectId" value={projectId} />
      <Input name="title" placeholder="Tiêu đề bài" />
      <Textarea name="text" rows={10} placeholder="Dán toàn bộ nội dung bài báo…" />
      <Button type="submit" size="sm" variant="outline" disabled={busy}>
        Lưu nội dung dán
      </Button>
    </ActionForm>
  );
}

function fallbackForms(projectId: string) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">{refetchButtons(projectId, false)}</div>
      {pasteForm(projectId, false)}
    </div>
  );
}
