import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { Clapperboard, ExternalLink, Eye, FileText, Film, Newspaper, PencilLine, Send, Trash2 } from "lucide-react";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { PipelineStatus } from "@/components/pipeline-status";
import { ProjectStateIcon, stateLabel } from "@/components/project-state";
import { SectionTabs, StickyToolbar, type SectionTab } from "@/components/sticky-toolbar";
import { VideoButton } from "@/components/video-dialog";
import { ScriptReview } from "@/components/script-review";
import { ReviewPanel } from "@/components/review-panel";
import { PublishPanel, type PublicationView, type PublishChannel } from "@/components/publish-panel";
import { TimelineSummary, type BuildJson } from "@/components/timeline-summary";
import type { Timeline } from "@ai-news/video/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { StoredFaithfulness, StoredScript } from "@/lib/llm/schemas";
import { DURATION_PRESETS, SCRIPT_TONES } from "@/lib/prompts/defaults";
import { flagsEnabled } from "@/lib/flags";
import { buildStatus, busyStep } from "@/lib/project-state";
import { buildMetadata, PLATFORM_SPEC, type Analytics } from "@/lib/publish/platforms";
import { presignGet } from "@/lib/r2";
import { canApprove, needsFaithfulnessOverride } from "@/lib/review";
import { displayHost } from "@/lib/url";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { dailyLimit, usedToday } from "@/lib/quota";
import {
  confirmArticle,
  deleteProject,
  pasteArticle,
  pinRender,
  refetchArticle,
  requestAssets,
  requestRender,
  requestScript,
} from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { built: "dựng", edited: "sửa", regenerated: "tạo lại" };
const RENDER_LABEL: Record<string, string> = {
  queued: "chờ",
  rendering: "đang kết xuất",
  post_processing: "hậu kỳ + QA",
  qa_failed: "QA không đạt",
  done: "xong",
  failed: "lỗi",
};

function PresetFields({ durationSec, tone }: { durationSec: number; tone: string }) {
  return (
    <div className="grid flex-1 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
      <div className="space-y-1">
        <Label htmlFor="durationSec">Thời lượng</Label>
        <NativeSelect id="durationSec" name="durationSec" defaultValue={String(durationSec)} className="w-full">
          {DURATION_PRESETS.map((d) => (
            <option key={d} value={d}>
              {d} giây
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tone">Giọng điệu</Label>
        <NativeSelect id="tone" name="tone" defaultValue={tone} className="w-full">
          {SCRIPT_TONES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.vi} · {t.en}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

/** Segmented picker (white pill on a grey track) for script / timeline versions. */
function VersionPills({
  items,
}: {
  items: Array<{ key: string; href: string; label: string; active: boolean; title?: string }>;
}) {
  return (
    <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 text-xs scrollbar-none">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          title={it.title}
          aria-current={it.active ? "true" : undefined}
          className={`inline-flex h-8 shrink-0 items-center rounded-md px-2.5 font-medium whitespace-nowrap transition-colors pointer-coarse:h-9 ${it.active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; t?: string; duplicate?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ws = await requireWorkspace();
  const writer = canWrite(ws);

  const data = await withOrgContext(ws, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!project) return null;
    // One round trip to the pooler is ~60 ms; issue the independent queries together so the
    // connection pipelines them instead of paying that ten times in a row.
    const [article, scripts, timelines, renders, reviews, [{ openComments }], channels, grants, publications, kits] =
      await Promise.all([
        tx.query.articles.findFirst({
          where: eq(schema.articles.projectId, id),
          orderBy: desc(schema.articles.createdAt),
        }),
        tx.query.scripts.findMany({ where: eq(schema.scripts.projectId, id), orderBy: desc(schema.scripts.version) }),
        tx.query.timelines.findMany({
          where: eq(schema.timelines.projectId, id),
          orderBy: desc(schema.timelines.version),
        }),
        tx.query.renders.findMany({ where: eq(schema.renders.projectId, id), orderBy: desc(schema.renders.createdAt) }),
        tx
          .select({
            id: schema.projectReviews.id,
            action: schema.projectReviews.action,
            note: schema.projectReviews.note,
            timelineVersion: schema.projectReviews.timelineVersion,
            faithfulnessOverride: schema.projectReviews.faithfulnessOverride,
            createdAt: schema.projectReviews.createdAt,
            actorName: schema.user.name,
          })
          .from(schema.projectReviews)
          .leftJoin(schema.user, eq(schema.user.id, schema.projectReviews.actorId))
          .where(eq(schema.projectReviews.projectId, id))
          .orderBy(desc(schema.projectReviews.createdAt))
          .limit(10),
        tx
          .select({ openComments: count() })
          .from(schema.comments)
          .where(and(eq(schema.comments.projectId, id), isNull(schema.comments.resolvedAt))),
        tx.query.channels.findMany({
          where: eq(schema.channels.organizationId, project.organizationId),
          orderBy: [schema.channels.platform, schema.channels.name],
        }),
        tx.query.channelGrants.findMany({ where: eq(schema.channelGrants.userId, ws.userId) }),
        tx
          .select({
            id: schema.publications.id,
            platform: schema.publications.platform,
            channelId: schema.publications.channelId,
            status: schema.publications.status,
            attempts: schema.publications.attempts,
            scheduledAt: schema.publications.scheduledAt,
            publishedAt: schema.publications.publishedAt,
            platformUrl: schema.publications.platformUrl,
            privacy: schema.publications.privacy,
            aiDisclosure: schema.publications.aiDisclosure,
            error: schema.publications.error,
            analyticsJson: schema.publications.analyticsJson,
            renderId: schema.publications.renderId,
            createdByName: schema.user.name,
          })
          .from(schema.publications)
          .leftJoin(schema.user, eq(schema.user.id, schema.publications.createdBy))
          .where(eq(schema.publications.projectId, id))
          .orderBy(desc(schema.publications.createdAt)),
        tx
          .select({ id: schema.brandKits.id, name: schema.brandKits.name, isDefault: schema.brandKits.isDefault })
          .from(schema.brandKits)
          .where(eq(schema.brandKits.organizationId, ws.organizationId))
          .orderBy(desc(schema.brandKits.isDefault), schema.brandKits.name),
      ]);
    return {
      project,
      article,
      scripts,
      timelines,
      renders,
      reviews,
      openComments,
      channels,
      grants,
      publications,
      kits,
    };
  });
  if (!data) notFound();
  const { project, article, scripts, timelines, renders, reviews, openComments, channels, grants, publications, kits } =
    data;
  const projectKit = kits.find((k) => k.id === project.brandKitId) ?? null;
  // Brand kits are shared across channels; the logo is the channel's and can differ per render.
  const logoChannels = channels.filter((c) => c.logoPath);
  const logoName = (channelId: string | null) =>
    channelId ? (channels.find((c) => c.id === channelId)?.name ?? "kênh đã xoá") : "bộ nhận diện";
  const logoSelect = (id: string) =>
    logoChannels.length ? (
      <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor={id}>
        logo
        <NativeSelect
          id={id}
          name="logoChannelId"
          fieldSize="sm"
          defaultValue={logoChannels.some((c) => c.id === project.logoChannelId) ? project.logoChannelId! : ""}
          className="max-w-52"
        >
          <option value="">của bộ nhận diện</option>
          {logoChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {PLATFORM_SPEC[c.platform].label}
            </option>
          ))}
        </NativeSelect>
      </label>
    ) : null;
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
  const publisher = writer && canApprove(ws);
  const imageKeys = Array.from(
    new Set((timelineJson?.scenes ?? []).flatMap((sc) => (sc.visual.kind === "image" ? [sc.visual.src] : []))),
  );
  const recentRenders = renders.slice(0, 10);
  // Everything below is independent: presigning is local crypto and the quota / flag lookups are one query each.
  const [
    imageSigned,
    mixUrl,
    renderSigned,
    screenshotUrl,
    [renderLimit, renderUsed],
    publishFlags,
    [publishLimit, publishUsed],
  ] = await Promise.all([
    Promise.all(imageKeys.map((key) => sign(key))),
    sign(timelineJson?.audio.mixSrc),
    Promise.all(
      recentRenders.map(
        async (r) =>
          [
            r.id,
            { video: r.status === "done" ? await sign(r.outputPath, 3600) : null, cover: await sign(r.coverPath) },
          ] as const,
      ),
    ),
    sign(article?.screenshotPath),
    writer ? Promise.all([dailyLimit(ws.userId, "render_minutes"), usedToday(ws.userId, "render_minutes")]) : [0, 0],
    publisher
      ? flagsEnabled(["publish_youtube", "publish_facebook", "publish_instagram", "publish_tiktok", "scheduling"])
      : ({} as Record<string, boolean>),
    publisher ? Promise.all([dailyLimit(ws.userId, "publishes"), usedToday(ws.userId, "publishes")]) : [0, 0],
  ]);
  const imageUrls: Record<string, string> = {};
  imageKeys.forEach((key, i) => {
    const u = imageSigned[i];
    if (u) imageUrls[key] = u;
  });
  const renderLinks = new Map<string, { video: string | null; cover: string | null }>(renderSigned);
  // Publishing (phase 5): the approved version's finished render, granted channels, defaults from the script's per-platform metadata.
  const approvedRender = project.approvedTimelineId
    ? (renders.find((r) => r.timelineId === project.approvedTimelineId && r.status === "done") ?? null)
    : null;
  // The version worth re-rendering for other channels: the approved one, else the newest that has a finished render.
  const rerenderTimeline =
    timelines.find(
      (t) => t.id === (project.approvedTimelineId ?? renders.find((r) => r.status === "done")?.timelineId),
    ) ?? null;
  const approvedRenders = renders.filter((r) => r.status === "done" && r.timelineId === rerenderTimeline?.id);
  const renderedLogos = [
    ...new Set(
      approvedRenders.map((r) =>
        r.logoChannelId ? (channels.find((c) => c.id === r.logoChannelId)?.name ?? "kênh đã xoá") : "bộ nhận diện",
      ),
    ),
  ];
  const approvedScript =
    scripts.find((s) => s.id === timelines.find((t) => t.id === project.approvedTimelineId)?.scriptId) ??
    scripts[0] ??
    null;
  const scriptMeta = (approvedScript?.scenesJson as unknown as StoredScript | null)?.metadata ?? null;
  const publishChannels: PublishChannel[] = channels.map((c) => ({
    id: c.id,
    platform: c.platform,
    name: c.name,
    granted: ws.isAdmin || grants.some((g) => g.channelId === c.id),
    enabled: c.enabled && Boolean(c.vaultRef),
    healthy: c.healthy,
    hasLogo: Boolean(c.logoPath),
    flagOn: Boolean(publishFlags[PLATFORM_SPEC[c.platform].flag]),
    defaults: buildMetadata({
      platform: c.platform,
      meta: scriptMeta?.[PLATFORM_SPEC[c.platform].metadataKey] ?? null,
      fallbackTitle: project.title ?? project.url,
      language: project.language,
      source: { siteName: article?.siteName ?? null, url: article?.canonicalUrl ?? project.url },
      aiDisclosure: project.aiDisclosure,
    }),
  }));
  const publicationViews: PublicationView[] = publications.map((x) => ({
    id: x.id,
    platform: x.platform,
    channelName: channels.find((c) => c.id === x.channelId)?.name ?? "?",
    status: x.status,
    attempts: x.attempts,
    scheduledAt: x.scheduledAt?.toISOString() ?? null,
    publishedAt: x.publishedAt?.toISOString() ?? null,
    platformUrl: x.platformUrl,
    privacy: x.privacy,
    aiDisclosure: x.aiDisclosure,
    error: x.error,
    analytics: x.analyticsJson
      ? (({ views, likes, comments, shares, pulledAt }) => ({ views, likes, comments, shares, pulledAt }))(
          x.analyticsJson as unknown as Analytics,
        )
      : null,
    renderVersion: renders.find((r) => r.id === x.renderId)?.timelineVersion ?? null,
    createdByName: x.createdByName,
  }));
  const status = buildStatus({
    project,
    latestScriptVersion: scripts[0]?.version ?? 0,
    latestTimelineVersion: timelines[0]?.version ?? 0,
    renders: {
      total: renders.length,
      active: renders.filter((r) => r.status === "queued" || r.status === "rendering" || r.status === "post_processing")
        .length,
    },
    publications: {
      total: publications.length,
      active: publications.filter((x) => x.status === "publishing" || x.status === "processing").length,
    },
  });
  const busy = Boolean(busyStep(project));
  const selected = scripts.find((s) => String(s.version) === sp.v) ?? scripts[0] ?? null;
  const flags = article?.flags ?? {};
  const flagNotes = [
    flags.paywall ? "Bài có tường phí: nội dung có thể bị cắt, hãy kiểm tra hoặc dán thủ công." : null,
    flags.liveBlog ? "Đây là bài tường thuật trực tiếp: nội dung thay đổi liên tục, nên chọn một mốc thời gian." : null,
    flags.videoOnly ? "Trang chủ yếu là video, ít chữ để dựng kịch bản." : null,
    flags.short ? "Bài rất ngắn; kịch bản sẽ hạn chế." : null,
  ].filter(Boolean) as string[];

  // ---- sticky toolbar: the next step of the pipeline, the editor, and jumps to each section.
  // Buttons outside a form submit it through the `form` attribute (ids on the <ActionForm>s below).
  const confirmed = Boolean(article?.confirmedAt);
  const nextStep: { form: string; label: string; icon: React.ReactNode } | null = !writer
    ? null
    : article && !confirmed
      ? { form: "confirm-form", label: "Xác nhận văn bản", icon: <Newspaper /> }
      : confirmed && !scripts.length
        ? { form: "script-form", label: "Tạo kịch bản", icon: <FileText /> }
        : scripts.length && !timelines.length
          ? { form: "build-form", label: "Dựng video", icon: <Clapperboard /> }
          : null;
  const tabs: SectionTab[] = [
    ...(article && !confirmed ? [{ id: "article", label: "Bài báo", icon: <Newspaper /> }] : []),
    ...(confirmed ? [{ id: "script", label: "Kịch bản", icon: <FileText /> }] : []),
    ...(scripts.length ? [{ id: "build", label: "Dựng", icon: <Clapperboard /> }] : []),
    ...(timelines.length ? [{ id: "review", label: "Duyệt", icon: <Eye /> }] : []),
    ...(timelines.length && (project.approvedTimelineId || publications.length)
      ? [{ id: "publish", label: "Đăng", icon: <Send /> }]
      : []),
    ...(renders.length || project.busyStep === "render" ? [{ id: "renders", label: "Kết xuất", icon: <Film /> }] : []),
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 sm:space-y-6">
      <div className="band-head relative flex items-start gap-3">
        <ProjectStateIcon state={project.state} className="mt-0.5 hidden sm:flex" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">
            <Link href="/app" className="hover:underline">
              Dự án
            </Link>{" "}
            / {displayHost(project.url)}
          </div>
          <h1 className="line-clamp-2 text-lg font-medium tracking-tight sm:text-xl">
            {project.title ?? project.url}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge
              variant={
                project.state === "failed"
                  ? "destructive"
                  : project.state === "approved" || project.state === "rendered" || project.state === "published"
                    ? "success"
                    : project.state === "scripted"
                      ? "default"
                      : "secondary"
              }
            >
              {stateLabel(project.state)}
            </Badge>
            {project.autoPipeline ? <Badge variant="default">tự động</Badge> : null}
            <Badge variant="outline">{project.language === "vi" ? "Tiếng Việt" : "English"}</Badge>
            {project.sensitiveTopic ? <Badge variant="destructive">chủ đề nhạy cảm → cần publisher duyệt</Badge> : null}
            {project.political ? (
              <Badge variant="secondary" title="Chỉ ảnh / video thật của tin; không dùng stock hay ảnh AI">
                chính trị: không stock / AI
              </Badge>
            ) : null}
            <a
              href={project.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-6 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden /> mở bài gốc
            </a>
          </div>
        </div>
        {writer ? (
          <ActionForm action={deleteProject} className="shrink-0">
            <input type="hidden" name="projectId" value={project.id} />
            <Button
              type="submit"
              size="icon-sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              title="Xoá dự án"
              aria-label="Xoá dự án"
            >
              <Trash2 />
            </Button>
          </ActionForm>
        ) : null}
      </div>

      <StickyToolbar tabs={tabs.length > 1 ? <SectionTabs tabs={tabs} /> : undefined}>
        {nextStep ? (
          <Button type="submit" form={nextStep.form} disabled={busy}>
            {nextStep.icon} {nextStep.label}
          </Button>
        ) : null}
        {timelineJson && selectedTimeline ? (
          <Button
            variant={nextStep ? "outline" : "default"}
            render={<Link href={`/app/projects/${project.id}/edit?t=${selectedTimeline.version}`} />}
          >
            <PencilLine /> {writer ? "Trình chỉnh sửa" : "Xem trước"}
          </Button>
        ) : null}
        {writer && timelineJson && selectedTimeline ? (
          <Button type="submit" form="render-form" variant="outline" disabled={busy}>
            <Film /> Kết xuất v{selectedTimeline.version}
          </Button>
        ) : null}
        {writer && scripts.length && timelines.length ? (
          <Button type="submit" form="build-form" variant="ghost" disabled={busy}>
            <Clapperboard /> Dựng lại
          </Button>
        ) : null}
        {writer && confirmed && scripts.length ? (
          <Button type="submit" form="script-form" variant="ghost" disabled={busy}>
            <FileText /> Kịch bản mới
          </Button>
        ) : null}
      </StickyToolbar>

      <PipelineStatus initial={status} />
      {sp.duplicate ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          Bài này đã có dự án trong workspace; bạn đang xem dự án đó.
        </p>
      ) : null}
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

      {/* Wide screens: the pipeline (article → script → build) on the left, review / publish / renders beside it, so the page stays short. */}
      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[minmax(0,1fr)_440px] xl:items-start">
        <div className="min-w-0 space-y-4 sm:space-y-6">
          {/* ---------------- Article ---------------- */}
          {!article ? (
            <Card id="article" className="scroll-mt-3">
              <CardHeader>
                <CardTitle>{busy ? "Đang lấy bài báo…" : "Chưa lấy được bài báo"}</CardTitle>
                <CardDescription>
                  {busy
                    ? "Cloudflare Browser Rendering → HTTP → Firecrawl. Trang tự cập nhật khi xong."
                    : "Thử lấy lại, dùng Firecrawl, hoặc dán nội dung bài thủ công bên dưới."}
                </CardDescription>
              </CardHeader>
              {!busy && writer ? <CardContent>{fallbackForms(project.id)}</CardContent> : null}
            </Card>
          ) : !article.confirmedAt ? (
            <Card id="article" className="scroll-mt-3">
              <CardHeader>
                <CardTitle>Xác nhận nội dung bài báo</CardTitle>
                <CardDescription>
                  Lấy bằng {article.fetchMethod} · {article.wordCount} từ ·{" "}
                  {article.siteName ?? displayHost(article.canonicalUrl)}
                  {article.author ? ` · ${article.author}` : ""}
                  {article.publishedAt ? ` · ${article.publishedAt.toISOString().slice(0, 10)}` : ""}. Sửa nếu cần rồi
                  xác nhận; kịch bản chỉ được tạo từ văn bản đã xác nhận.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {article.images.length ? (
                  <div className="flex gap-2 overflow-x-auto">
                    {article.images.slice(0, 6).map((im) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={im.url}
                        src={im.url}
                        alt={im.alt ?? ""}
                        className="h-24 rounded border object-cover"
                        loading="lazy"
                      />
                    ))}
                  </div>
                ) : null}
                <ActionForm id="confirm-form" action={confirmArticle} className="space-y-3">
                  <input type="hidden" name="projectId" value={project.id} />
                  <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                    <div className="space-y-1">
                      <Label htmlFor="title">Tiêu đề</Label>
                      <Input id="title" name="title" defaultValue={article.title ?? ""} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="language">Ngôn ngữ</Label>
                      <NativeSelect id="language" name="language" defaultValue={project.language} className="w-full">
                        <option value="vi">Tiếng Việt</option>
                        <option value="en">English</option>
                      </NativeSelect>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="text">Nội dung</Label>
                    <Textarea
                      id="text"
                      name="text"
                      rows={18}
                      defaultValue={article.text}
                      className="text-sm leading-relaxed"
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={!writer || busy} className="w-full sm:w-auto">
                      Xác nhận văn bản
                    </Button>
                  </div>
                </ActionForm>
                {/* Separate forms: they must not nest inside the confirm form. */}
                {writer ? <div className="flex flex-wrap gap-2">{refetchButtons(project.id, busy)}</div> : null}
                {writer ? (
                  <CollapsibleSection
                    variant="plain"
                    defaultOpen={false}
                    title="Dán nội dung thủ công"
                    className="text-sm"
                  >
                    {pasteForm(project.id, busy)}
                  </CollapsibleSection>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {/* ---------------- Script ---------------- */}
          {article?.confirmedAt ? (
            <Card id="script" className="scroll-mt-3">
              <CardHeader>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <CardTitle>Kịch bản</CardTitle>
                  {writer ? (
                    <ActionForm
                      id="script-form"
                      action={requestScript}
                      className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3 lg:shrink-0"
                    >
                      <input type="hidden" name="projectId" value={project.id} />
                      <PresetFields durationSec={project.durationSec} tone={project.tone} />
                      <Button type="submit" disabled={busy} className="self-auto sm:self-center">
                        <FileText /> {scripts.length ? "Tạo phiên bản mới" : "Tạo kịch bản"}
                      </Button>
                    </ActionForm>
                  ) : null}
                </div>
                <CardDescription>
                  Claude Opus 5 viết kịch bản từ bài đã xác nhận, rồi kiểm chứng từng cảnh. Mỗi lần tạo là một phiên bản
                  mới.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {scripts.length > 1 ? (
                  <VersionPills
                    items={scripts.map((s) => ({
                      key: s.id,
                      href: `/app/projects/${project.id}?v=${s.version}`,
                      label: `v${s.version}`,
                      active: selected?.id === s.id,
                    }))}
                  />
                ) : null}
                {selected ? (
                  // Once the video is built the script is reference material: collapsed, one line of facts in the header.
                  <CollapsibleSection
                    variant="plain"
                    defaultOpen={!timelines.length}
                    title={`Kịch bản v${selected.version}`}
                    summary={scriptSummary(selected)}
                    summaryAlways
                  >
                    <ScriptReview
                      article={{
                        title: article.title,
                        text: article.text,
                        siteName: article.siteName,
                        url: article.canonicalUrl,
                        screenshotUrl,
                      }}
                      script={selected.scenesJson as unknown as StoredScript}
                      faithfulness={
                        selected.faithfulnessJson && "scenes" in selected.faithfulnessJson
                          ? (selected.faithfulnessJson as unknown as StoredFaithfulness)
                          : null
                      }
                      meta={{
                        version: selected.version,
                        createdAt: selected.createdAt.toISOString(),
                        costUsd: selected.costUsd,
                        inputTokens: selected.inputTokens,
                        outputTokens: selected.outputTokens,
                      }}
                    />
                  </CollapsibleSection>
                ) : !busy ? (
                  <p className="text-sm text-muted-foreground">
                    Chưa có kịch bản. Chọn thời lượng và giọng điệu rồi bấm “Tạo kịch bản”.
                  </p>
                ) : null}
                <CollapsibleSection
                  variant="plain"
                  defaultOpen={false}
                  title="Văn bản đã xác nhận"
                  summary="sửa và xác nhận lại"
                  className="text-sm"
                >
                  <ActionForm action={confirmArticle} className="space-y-2">
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="language" value={project.language} />
                    <Input name="title" defaultValue={article.title ?? ""} />
                    <Textarea name="text" rows={12} defaultValue={article.text} className="text-sm" />
                    <div className="flex justify-end">
                      <Button type="submit" size="sm" variant="outline" disabled={!writer || busy}>
                        Lưu và xác nhận lại
                      </Button>
                    </div>
                  </ActionForm>
                  {writer ? <div className="mt-2 flex flex-wrap gap-2">{refetchButtons(project.id, busy)}</div> : null}
                </CollapsibleSection>
              </CardContent>
            </Card>
          ) : null}

          {/* ---------------- Assets + timeline (phase 3) ---------------- */}
          {scripts.length ? (
            <Card id="build" className="scroll-mt-3">
              <CardHeader>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <CardTitle>Dựng video</CardTitle>
                  {writer ? (
                    <ActionForm
                      id="build-form"
                      action={requestAssets}
                      className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3 lg:shrink-0"
                    >
                      <input type="hidden" name="projectId" value={project.id} />
                      <input type="hidden" name="scriptId" value={selected?.id ?? ""} />
                      {kits.length > 1 ? (
                        <label
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                          title={project.brandKitReason ?? undefined}
                        >
                          bộ nhận diện
                          <NativeSelect
                            name="brandKitId"
                            fieldSize="sm"
                            defaultValue={projectKit?.id ?? ""}
                            className="max-w-48 flex-1"
                          >
                            <option value="">mặc định{kits[0]?.isDefault ? ` (${kits[0].name})` : ""}</option>
                            {kits.map((k) => (
                              <option key={k.id} value={k.id}>
                                {k.name}
                                {k.id === project.brandKitId && project.brandKitSource === "auto" ? " · tự chọn" : ""}
                              </option>
                            ))}
                          </NativeSelect>
                        </label>
                      ) : null}
                      <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" name="skipStock" /> bỏ qua stock
                      </label>
                      <Button type="submit" disabled={busy}>
                        <Clapperboard />{" "}
                        {timelines.length
                          ? `Dựng lại từ kịch bản v${selected?.version ?? scripts[0].version}`
                          : `Dựng từ kịch bản v${selected?.version ?? scripts[0].version}`}
                      </Button>
                    </ActionForm>
                  ) : null}
                </div>
                <CardDescription>
                  Lời đọc Google TTS + mốc từ; hình theo thứ tự ưu tiên ảnh bài gốc → ảnh báo khác + video web cùng tin
                  (yt-dlp, nếu bật) → clip stock Pexels/Pixabay (Haiku xếp hạng) → ảnh AI (Gemini, nếu bật); nhạc nền,
                  trộn âm −16 LUFS, rồi timeline. Mỗi lần dựng là một phiên bản mới.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {kits.length > 1 && project.brandKitSource === "auto" && projectKit ? (
                  <p className="text-xs text-muted-foreground">
                    Bộ nhận diện tự chọn theo nội dung: <b>{projectKit.name}</b>
                    {project.brandKitReason ? ` – ${project.brandKitReason}` : ""}. Đổi ở ô bên trên trước khi dựng,
                    hoặc đổi ngay trong trình chỉnh sửa mà không cần dựng lại.
                  </p>
                ) : null}
                {timelines.length > 1 ? (
                  <VersionPills
                    items={timelines.map((t) => ({
                      key: t.id,
                      href: `/app/projects/${project.id}?v=${sp.v ?? ""}&t=${t.version}`,
                      title: t.changes.join(" · "),
                      label: `v${t.version} · ${KIND_LABEL[t.kind] ?? t.kind}${t.id === project.approvedTimelineId ? " ✓" : ""}`,
                      active: selectedTimeline?.id === t.id,
                    }))}
                  />
                ) : null}
                {timelineJson && selectedTimeline ? (
                  <>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Button
                        className="sm:shrink-0"
                        render={<Link href={`/app/projects/${project.id}/edit?t=${selectedTimeline.version}`} />}
                      >
                        <PencilLine /> {writer ? "Mở trình chỉnh sửa" : "Xem trước trong trình chỉnh sửa"}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Xem trước, đổi thứ tự / clip / phụ đề, đọc lại lời, chọn ảnh bìa, bình luận, gửi duyệt.
                        {openComments ? ` ${openComments} bình luận mở.` : ""}
                        {selectedTimeline.changes.length
                          ? ` Thay đổi v${selectedTimeline.version}: ${selectedTimeline.changes.slice(0, 3).join(" · ")}.`
                          : ""}
                      </span>
                    </div>
                    {/* Scene-by-scene detail folds away once this version is approved; the header keeps the totals. */}
                    <CollapsibleSection
                      variant="plain"
                      defaultOpen={selectedTimeline.id !== project.approvedTimelineId}
                      title={`Timeline v${selectedTimeline.version}`}
                      summary={`${(timelineJson.durationFrames / timelineJson.fps).toFixed(1)} s · ${timelineJson.scenes.length} cảnh · ${timelineJson.captions.length} phụ đề`}
                      summaryAlways
                    >
                      <TimelineSummary
                        timeline={timelineJson}
                        build={selectedTimeline.buildJson as BuildJson}
                        imageUrls={imageUrls}
                        mixUrl={mixUrl}
                      />
                    </CollapsibleSection>
                    {writer ? (
                      <ActionForm
                        id="render-form"
                        action={requestRender}
                        className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
                      >
                        <input type="hidden" name="projectId" value={project.id} />
                        <input type="hidden" name="timelineId" value={selectedTimeline.id} />
                        {logoSelect("render-logo")}
                        <Button
                          type="submit"
                          disabled={busy}
                          variant={selectedTimeline.id === project.approvedTimelineId ? "default" : "outline"}
                        >
                          <Film />{" "}
                          {selectedTimeline.id === project.approvedTimelineId
                            ? `Kết xuất bản duyệt v${selectedTimeline.version}`
                            : `Kết xuất thử v${selectedTimeline.version}`}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Remotion Lambda → chuẩn hoá −14 LUFS → QA. Hôm nay đã dùng {renderUsed}/{renderLimit} phút kết
                          xuất.
                          {selectedTimeline.id !== project.approvedTimelineId
                            ? " Bản chưa duyệt chỉ là kết xuất thử."
                            : ""}
                        </span>
                      </ActionForm>
                    ) : null}
                  </>
                ) : !busy ? (
                  <p className="text-sm text-muted-foreground">
                    Chưa có timeline. Bấm “Dựng” để tạo lời đọc, B-roll và nhạc từ kịch bản đã chọn.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-4 sm:space-y-6">
          {/* ---------------- Review / approval (phase 4) ---------------- */}
          {timelines.length ? (
            <Card id="review" className="scroll-mt-3">
              <CardHeader>
                <CardTitle>Duyệt</CardTitle>
                <CardDescription>
                  Người dựng gửi phiên bản mới nhất; publisher duyệt hoặc trả lại. Mọi bước được ghi log; cảnh không căn
                  cứ cần publisher xác nhận bỏ qua.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ReviewPanel
                  projectId={project.id}
                  state={project.state}
                  latestTimeline={{ id: timelines[0].id, version: timelines[0].version }}
                  approvedTimelineId={project.approvedTimelineId}
                  canEdit={writer}
                  canApprove={canApprove(ws)}
                  busy={busy}
                  needsOverride={needsFaithfulnessOverride(
                    scripts.find((s) => s.id === timelines[0].scriptId) ?? scripts[0],
                  )}
                  faithfulnessCounts={(() => {
                    const f = (scripts.find((s) => s.id === timelines[0].scriptId) ?? scripts[0])?.faithfulnessJson as
                      StoredFaithfulness | null | undefined;
                    return f && "counts" in f ? f.counts : null;
                  })()}
                  sensitiveTopic={project.sensitiveTopic}
                  reviews={reviews.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
                />
              </CardContent>
            </Card>
          ) : null}

          {/* ---------------- Publish (phase 5) ---------------- */}
          {timelines.length && (project.approvedTimelineId || publications.length) ? (
            <Card id="publish" className="scroll-mt-3">
              <CardHeader>
                <CardTitle>Đăng</CardTitle>
                <CardDescription>
                  YouTube Shorts, Facebook / Instagram Reels, TikTok. Chỉ đăng bản kết xuất của phiên bản đã duyệt; mỗi
                  lượt có khoá idempotency riêng, trạng thái xử lý được kiểm tra định kỳ, số liệu kéo về hằng ngày.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PublishPanel
                  projectId={project.id}
                  render={
                    approvedRender
                      ? {
                          id: approvedRender.id,
                          version: approvedRender.timelineVersion,
                          durationSec: approvedRender.durationSec ? Number(approvedRender.durationSec) : null,
                        }
                      : null
                  }
                  renders={renders
                    .filter(
                      (r) =>
                        r.status === "done" &&
                        project.approvedTimelineId &&
                        r.timelineId === project.approvedTimelineId,
                    )
                    .map((r) => ({ id: r.id, logoChannelId: r.logoChannelId, logoName: logoName(r.logoChannelId) }))}
                  canPublish={publisher}
                  schedulingOn={Boolean(publishFlags.scheduling)}
                  aiDisclosure={project.aiDisclosure}
                  channels={publishChannels}
                  publications={publicationViews}
                  quota={{ used: publishUsed, limit: publishLimit }}
                />
              </CardContent>
            </Card>
          ) : null}

          {/* ---------------- Renders ---------------- */}
          {renders.length || project.busyStep === "render" ? (
            <Card id="renders" className="scroll-mt-3 mb-36">
              <CardHeader>
                <CardTitle>Kết xuất</CardTitle>
                <CardDescription>
                  1080×1920, 30 fps, H.264 CRF 18, −14 LUFS. Bản ghim không bao giờ hết hạn; bản khác giữ 12 tháng.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {writer && logoChannels.length && rerenderTimeline ? (
                  <ActionForm
                    action={requestRender}
                    className="flex flex-col gap-2 rounded-lg border border-dashed p-3 sm:flex-row sm:flex-wrap sm:items-center"
                  >
                    <input type="hidden" name="projectId" value={project.id} />
                    <input type="hidden" name="timelineId" value={rerenderTimeline.id} />
                    <span className="text-xs font-medium">
                      Kết xuất lại v{rerenderTimeline.version} với logo kênh khác
                    </span>
                    {logoSelect("rerender-logo")}
                    <Button type="submit" size="sm" variant="outline" disabled={busy}>
                      Kết xuất
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      Cùng nội dung, chỉ khác logo; tính phút kết xuất như thường. Đã có:{" "}
                      {renderedLogos.length ? renderedLogos.join(", ") : "chưa có bản nào"}.
                    </span>
                  </ActionForm>
                ) : null}
                {renderRows(renders.slice(0, 3))}
                {renders.length > 3 ? (
                  <CollapsibleSection
                    variant="plain"
                    defaultOpen={false}
                    title={`Bản cũ hơn (${Math.min(renders.length, 10) - 3})`}
                    bodyClassName="space-y-3"
                  >
                    {renderRows(renders.slice(3, 10))}
                  </CollapsibleSection>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );

  function scriptSummary(s: (typeof scripts)[number]) {
    const scenes = (s.scenesJson as unknown as StoredScript).scenes.length;
    const f =
      s.faithfulnessJson && "counts" in s.faithfulnessJson
        ? (s.faithfulnessJson as unknown as StoredFaithfulness).counts
        : null;
    const bad = f ? f.unsupported + f.unchecked : 0;
    return `${scenes} cảnh${f ? ` · ${f.supported} ok${f.partial ? ` · ${f.partial} một phần` : ""}${bad ? ` · ${bad} không căn cứ` : ""}` : " · chưa kiểm chứng"}`;
  }

  function renderRows(list: typeof renders) {
    return list.map((r) => {
      const links = renderLinks.get(r.id);
      const checks =
        (r.qaJson as { checks?: Record<string, { ok: boolean; expected?: unknown; actual?: unknown }> } | null)
          ?.checks ?? {};
      return (
        <div key={r.id} className="flex gap-3 rounded-lg border p-2.5 text-sm">
          <div className="h-28 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
            {links?.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={links.cover} alt="" className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1">
              <Badge
                variant={
                  r.status === "done"
                    ? "default"
                    : r.status === "failed" || r.status === "qa_failed"
                      ? "destructive"
                      : "secondary"
                }
              >
                {RENDER_LABEL[r.status] ?? r.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                timeline v{r.timelineVersion} · {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                {r.durationSec ? ` · ${Number(r.durationSec).toFixed(1)} s` : ""}
                {r.costUsd ? ` · $${Number(r.costUsd).toFixed(3)}` : ""}
                {r.renderSeconds ? ` · ${Number(r.renderSeconds).toFixed(0)} s render` : ""}
              </span>
              <Badge variant="outline">logo: {logoName(r.logoChannelId)}</Badge>
              {r.pinned ? <Badge variant="outline">đã ghim</Badge> : null}
              {(r.qaJson as { overridden?: boolean } | null)?.overridden ? (
                <Badge variant="destructive">QA bị bỏ qua</Badge>
              ) : null}
              {r.timelineId && r.timelineId === project.approvedTimelineId ? (
                <Badge>bản duyệt</Badge>
              ) : (
                <Badge variant="outline">kết xuất thử</Badge>
              )}
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
                <VideoButton
                  src={links.video}
                  poster={links.cover}
                  title={project.title ?? project.url}
                  description={`timeline v${r.timelineVersion} · logo ${logoName(r.logoChannelId)}${r.durationSec ? ` · ${Number(r.durationSec).toFixed(0)} s` : ""}`}
                />
              ) : null}
              {/* Forced render past a failed QA: only on the newest render of that version, so a later good one hides it. */}
              {writer &&
              r.status === "qa_failed" &&
              r.timelineId &&
              renders.find((x) => x.timelineId === r.timelineId)?.id === r.id ? (
                <ActionForm action={requestRender}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="timelineId" value={r.timelineId} />
                  <input type="hidden" name="logoChannelId" value={r.logoChannelId ?? ""} />
                  <input type="hidden" name="skipQa" value="1" />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    title="Kết xuất lại đúng phiên bản và logo này; kết quả QA vẫn được ghi lại nhưng không còn chặn bản kết xuất. Tính phút kết xuất như thường."
                  >
                    Kết xuất lại, bỏ qua QA
                  </Button>
                </ActionForm>
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
    });
  }
}

function refetchButtons(projectId: string, busy: boolean) {
  return (
    <>
      {(["browser_rendering", "http", "firecrawl"] as const).map((m) => (
        <ActionForm key={m} action={refetchArticle}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="method" value={m} />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy}
            title="Thử cách này trước; nếu bị chặn hoặc lỗi, hệ thống tự chuyển sang các cách còn lại."
          >
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
