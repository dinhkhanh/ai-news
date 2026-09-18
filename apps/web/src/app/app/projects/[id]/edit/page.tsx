import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { PipelineStatus } from "@/components/pipeline-status";
import { EditorLoader } from "@/components/editor/editor-loader";
import type { EditorProps, VisualOption } from "@/components/editor/types";
import { Badge } from "@/components/ui/badge";
import { brandFromRow, listBrandKits } from "@/lib/media/brand";
import { docKeys } from "@/lib/media/editor";
import { channelLogo } from "@/lib/media/logo";
import { presignMap } from "@/lib/media/timeline-resolve";
import { storedFrame } from "@/lib/media/framing";
import type { PendingCapture } from "@/lib/media/visual-plan";
import { busyStep } from "@/lib/project-state";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { dailyLimit, usedToday } from "@/lib/quota";
import { presignGet } from "@/lib/r2";
import { loadProjectStatus } from "@/lib/project-status";
import { canApprove, docOfRow, verdictsOfScript } from "@/lib/review";
import { displayHost } from "@/lib/url";
import { canWrite, requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
// Server actions of this page include the media-Lambda transcode of a browser capture (`registerWebCapture`).
export const maxDuration = 120;

/**
 * Timeline editor (docs/PLAN.md §4.7): Remotion Player preview + scene track.
 * Loads one version (?t=<version>, default latest), every visual asset of the
 * project as swap options, the music library, comments and review history,
 * and presigns each R2 key once for browser playback.
 */
export default async function EditPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ws = await requireWorkspace();

  const data = await withOrgContext(ws, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!project) return null;
    const timelines = await tx.query.timelines.findMany({ where: eq(schema.timelines.projectId, id), orderBy: desc(schema.timelines.version) });
    const assets = await tx.query.assets.findMany({ where: eq(schema.assets.projectId, id), orderBy: desc(schema.assets.createdAt) });
    const comments = await tx
      .select({ id: schema.comments.id, body: schema.comments.body, sceneId: schema.comments.sceneId, atMs: schema.comments.atMs, createdAt: schema.comments.createdAt, resolvedAt: schema.comments.resolvedAt, authorName: schema.user.name, authorId: schema.comments.authorId })
      .from(schema.comments)
      .leftJoin(schema.user, eq(schema.user.id, schema.comments.authorId))
      .where(eq(schema.comments.projectId, id))
      .orderBy(desc(schema.comments.createdAt));
    const reviews = await tx
      .select({ id: schema.projectReviews.id, action: schema.projectReviews.action, note: schema.projectReviews.note, timelineVersion: schema.projectReviews.timelineVersion, faithfulnessOverride: schema.projectReviews.faithfulnessOverride, createdAt: schema.projectReviews.createdAt, actorName: schema.user.name })
      .from(schema.projectReviews)
      .leftJoin(schema.user, eq(schema.user.id, schema.projectReviews.actorId))
      .where(eq(schema.projectReviews.projectId, id))
      .orderBy(desc(schema.projectReviews.createdAt))
      .limit(20);
    const renders = await tx.query.renders.findMany({ where: eq(schema.renders.projectId, id), orderBy: desc(schema.renders.createdAt), limit: 4 });
    const channels = await tx.query.channels.findMany({ where: eq(schema.channels.organizationId, project.organizationId), orderBy: [schema.channels.platform, schema.channels.name] });
    const authors = await tx.select({ id: schema.user.id, name: schema.user.name }).from(schema.user);
    return { project, timelines, assets, comments, reviews, renders, channels, authors: new Map(authors.map((a) => [a.id, a.name])) };
  });
  if (!data) notFound();
  const { project, timelines, assets, comments, reviews, renders, channels } = data;
  const selected = timelines.find((t) => String(t.version) === sp.t) ?? timelines[0] ?? null;
  if (!selected) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <p className="text-sm">
          Dự án chưa có timeline.{" "}
          <Link href={`/app/projects/${id}`} className="underline">
            Quay lại dự án
          </Link>{" "}
          để dựng trước.
        </p>
      </div>
    );
  }
  const { doc, mix } = docOfRow(selected);
  const script = selected.scriptId ? await withOrgContext(ws, (tx) => tx.query.scripts.findFirst({ where: eq(schema.scripts.id, selected.scriptId!) })) : null;
  const verdicts = verdictsOfScript(script);
  const music = await withOrgContext(ws, (tx) => tx.select().from(schema.musicLibrary).orderBy(schema.musicLibrary.title).limit(50));

  // Every visual asset of the project is a swap option; stock rows remember the scene they were fetched for.
  const options: VisualOption[] = assets
    .filter((a) => a.origin === "stock" || a.origin === "article" || a.origin === "upload" || a.origin === "web_video" || a.origin === "ai")
    .map((a) => ({
      assetId: a.id,
      key: a.r2Path,
      kind: (a.mime ?? "").startsWith("image/") || a.origin === "article" ? "image" : "video",
      durationSec: a.durationSec ? Number(a.durationSec) : null,
      credit: a.attribution,
      thumbnailUrl: a.thumbnailUrl,
      provider: a.provider ?? a.origin,
      sceneId: a.sceneId,
      searchTerm: a.searchTerm,
      rankScore: a.rankScore ? Number(a.rankScore) : null,
      frame: storedFrame(a.meta),
    }));
  // YouTube picks the build could not download, minus the ones already recorded from a browser.
  const captured = new Set(assets.filter((a) => a.provider === "yt-capture").map((a) => (a.providerId ?? "").split("@")[0]));
  const captures = (((selected.buildJson as { webVideo?: { pending?: PendingCapture[] } }).webVideo?.pending ?? []) as PendingCapture[]).filter((c) => c.videoId && !captured.has(`youtube:${c.videoId}`));
  const brandKits = (await listBrandKits(ws)).map((k) => ({ id: k.id, name: k.name, isDefault: k.isDefault, brand: brandFromRow(k).brand }));
  const kitKeys = brandKits.flatMap((k) => [k.brand.logoSrc, k.brand.overlaySrc]).filter((k): k is string => Boolean(k));
  const logoChannel = await channelLogo(ws, project.logoChannelId);
  const keys = new Set<string>([...(logoChannel ? [logoChannel.logoPath] : []), ...docKeys(doc), ...options.map((o) => o.key), ...music.map((m) => m.r2Path), ...kitKeys]);
  if (mix?.mixKey) keys.add(mix.mixKey);
  // Article images have no remote thumbnail in R2; presign the key itself for the thumbnail grid.
  const urls = await presignMap(keys, 3600);

  const busy = busyStep(project);
  const writer = canWrite(ws);
  const [renderLimit, renderUsed] = writer ? await Promise.all([dailyLimit(ws.userId, "render_minutes"), usedToday(ws.userId, "render_minutes")]) : [0, 0];
  const renderUrls = await Promise.all(renders.map((r) => (r.status === "done" && r.outputPath ? presignGet(r.outputPath, 3600).catch(() => null) : null)));
  const status = await loadProjectStatus(ws, project.id);
  const props: EditorProps = {
    projectId: project.id,
    projectTitle: project.title ?? project.url,
    projectState: project.state,
    busyStep: busy,
    lastError: project.lastError,
    userId: ws.userId,
    canEdit: canWrite(ws),
    canApprove: canApprove(ws),
    approvedTimelineId: project.approvedTimelineId,
    sensitiveTopic: project.sensitiveTopic,
    political: project.political,
    version: { id: selected.id, version: selected.version, kind: selected.kind, changes: selected.changes, note: selected.note, createdAt: selected.createdAt.toISOString(), createdByName: selected.createdBy ? (data.authors.get(selected.createdBy) ?? null) : null, isLatest: selected.id === timelines[0].id },
    versions: timelines.map((t) => ({ id: t.id, version: t.version, kind: t.kind, changes: t.changes, createdAt: t.createdAt.toISOString(), createdByName: t.createdBy ? (data.authors.get(t.createdBy) ?? null) : null })),
    doc,
    mix: mix ? { mixKey: mix.mixKey, signature: mix.signature } : null,
    urls,
    options,
    captures: selected.id === timelines[0].id ? captures : [],
    music: music.map((m) => ({ id: m.id, title: m.title, key: m.r2Path, moodTags: m.moodTags, durationSec: m.durationSec ? Number(m.durationSec) : null, licence: m.licence })),
    previewLogo: logoChannel && urls[logoChannel.logoPath] ? { url: urls[logoChannel.logoPath], channelName: logoChannel.name } : null,
    brandKits,
    verdicts: verdicts?.verdicts ?? null,
    faithfulnessCounts: verdicts?.counts ?? null,
    comments: comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString(), resolvedAt: c.resolvedAt?.toISOString() ?? null })),
    reviews: reviews.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    exportInfo: {
      logoChannels: channels.filter((c) => c.logoPath).map((c) => ({ id: c.id, name: c.name, platformLabel: PLATFORM_SPEC[c.platform].label })),
      defaultLogoChannelId: project.logoChannelId,
      quota: { used: Math.ceil(renderUsed), limit: renderLimit },
      renders: renders.map((r, i) => ({
        id: r.id,
        status: r.status,
        timelineId: r.timelineId,
        version: r.timelineVersion,
        createdAt: r.createdAt.toISOString(),
        logoChannelId: r.logoChannelId,
        logoName: r.logoChannelId ? (channels.find((c) => c.id === r.logoChannelId)?.name ?? "kênh đã xoá") : "bộ nhận diện",
        videoUrl: renderUrls[i],
        error: r.error?.slice(0, 300) ?? null,
        canForce: r.status === "qa_failed" && Boolean(r.timelineId) && renders.find((x) => x.timelineId === r.timelineId)?.id === r.id,
        qaOverridden: Boolean((r.qaJson as { overridden?: boolean } | null)?.overridden),
      })),
    },
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            <Link href="/app" className="underline">
              Dự án
            </Link>{" "}
            /{" "}
            <Link href={`/app/projects/${project.id}`} className="underline">
              {displayHost(project.url)}
            </Link>{" "}
            / trình chỉnh sửa
          </div>
          <h1 className="truncate text-lg font-semibold tracking-tight">{project.title ?? project.url}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">timeline v{selected.version}</Badge>
          {status ? <PipelineStatus initial={status} variant="inline" /> : null}
          {project.approvedTimelineId === selected.id ? <Badge>đã duyệt</Badge> : null}
        </div>
      </div>
      <EditorLoader key={selected.id} {...props} />
    </div>
  );
}
