"use server";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectFetchRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { countWords } from "@/lib/fetch/readability";
import { channelLogo } from "@/lib/media/logo";
import { resolveVideoLink } from "@/lib/media/source-video";
import { findVoice } from "@/lib/media/tts";
import { runFetchDirect } from "@/lib/pipeline/direct";
import { parsePreset } from "@/lib/presets";
import { startProgress } from "@/lib/project-state";
import { assertQuota } from "@/lib/quota";
import { canonicalizeUrl, isPrivateHost } from "@/lib/url";
import { MIN_CONTENT_WORDS } from "@/lib/video-source";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * Create a project and start the fetch step. Three sources (`projects.source_kind`):
 * - a link to a news article: fetched by the extraction chain; duplicates are checked org-wide;
 * - a link to a video page (YouTube, TikTok, Facebook…, share links followed): the video is downloaded as the
 *   footage and its caption pre-fills the content the user writes; duplicates are checked the same way;
 * - content typed in (`mode=text`): stored at once as a confirmed article (a direct run, like a manual paste).
 */
export async function createProject(_: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const typed = str(fd, "mode") === "text";
    const text = typed ? String(fd.get("text") ?? "").replace(/\r\n?/g, "\n").trim() : "";
    const title = typed ? str(fd, "title") || text.split("\n")[0].slice(0, 90).trim() : "";
    if (typed && countWords(text) < MIN_CONTENT_WORDS.text) throw new Error(`Write at least ${MIN_CONTENT_WORDS.text} words of content`);
    const videoUrl = typed ? null : await resolveVideoLink(str(fd, "url"));
    const url = typed ? null : (videoUrl ?? canonicalizeUrl(str(fd, "url")));
    if (url && isPrivateHost(url)) throw new Error("That address is not a public website");
    const sourceKind = typed ? "text" : videoUrl ? "video" : "article";
    const { durationSec, tone } = parsePreset(fd);
    const force = fd.get("force") === "on";
    const auto = fd.get("auto") === "on";
    // Empty = let the article decide after the fetch (src/lib/media/brand.ts `chooseBrandKit`).
    const kitId = str(fd, "brandKitId");
    const kit = kitId ? await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.id, kitId)), columns: { id: true, name: true } })) : null;
    if (kitId && !kit) throw new Error("That brand kit no longer exists");
    // Whose logo the videos carry (brand kits are shared across channels); empty = the kit's own logo.
    const logoChannelId = str(fd, "logoChannelId");
    const logoChannel = await channelLogo(ws, logoChannelId);
    if (logoChannelId && !logoChannel) throw new Error("That channel has no logo (any more)");
    // Empty = the workspace default for the story's language, decided at build time.
    const voice = await findVoice(ws, str(fd, "voicePresetId"));
    // Auto mode will spend a script + a render on this user's behalf: fail fast if today's quota is already gone.
    if (auto) await Promise.all([assertQuota(ws.userId, "scripts"), assertQuota(ws.userId, "render_minutes")]);

    const existing = url
      ? await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: and(eq(schema.projects.organizationId, ws.organizationId), eq(schema.projects.canonicalUrl, url)) }))
      : undefined;
    if (existing && !force) {
      target = `/app/projects/${existing.id}?duplicate=1`;
      return `This ${sourceKind === "video" ? "video" : "article"} already has a project (${existing.state}). Opening it; tick "create anyway" to start another.`;
    }

    const [project] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.projects)
        .values({
          organizationId: ws.organizationId, ownerId: ws.userId, url, canonicalUrl: url, sourceKind, title: title || null, durationSec, tone, autoPipeline: auto,
          brandKitId: kit?.id ?? null, brandKitSource: kit ? "manual" : null, logoChannelId: logoChannel?.id ?? null, voicePresetId: voice?.id ?? null,
          // Typed content is saved in this request's `after()`, never through the queue: nothing to fetch, nothing to wait for.
          busyStep: "fetch", busyProgress: typed ? { ...startProgress("Lưu nội dung…"), direct: true } : startProgress(),
        })
        .returning({ id: schema.projects.id }),
    );
    await log("project.created", { url, sourceKind, ...(typed ? { words: countWords(text) } : {}), durationSec, tone, auto, brandKit: kit?.name ?? "auto", logoChannel: logoChannel?.name ?? null, voice: voice?.name ?? "default", duplicateOf: existing?.id ?? null }, project.id);
    if (typed) after(() => runFetchDirect({ projectId: project.id, organizationId: ws.organizationId, requestedBy: ws.userId, manual: { title, text } }));
    else await inngest.send(projectFetchRequested.create({ projectId: project.id, organizationId: ws.organizationId, requestedBy: ws.userId }));
    target = `/app/projects/${project.id}`;
    if (sourceKind === "video") return auto ? "Project created; downloading the video. Write its content, and the rest runs automatically…" : "Project created; downloading the video…";
    return auto ? "Project created; running fetch → script → build → render automatically…" : typed ? "Project created; saving your content…" : "Project created; fetching the article…";
  });
  if (target) redirect(target);
  return state;
}
