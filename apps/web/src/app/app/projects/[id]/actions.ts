"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { autoAfterFetch } from "@/inngest/auto-pipeline";
import { inngest } from "@/inngest/client";
import { projectAssetsRequested, projectFetchRequested, projectScriptRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { FETCH_METHOD_LABEL } from "@/lib/fetch";
import { countWords } from "@/lib/fetch/readability";
import { claimDirectRun, runFetchDirect, runScriptDirect } from "@/lib/pipeline/direct";
import { parsePreset } from "@/lib/presets";
import { busyStep, startProgress } from "@/lib/project-state";
import { assertQuota } from "@/lib/quota";
import { queueRender } from "@/lib/render-request";
import { copyObject } from "@/lib/r2";
import { MIN_CONTENT_WORDS } from "@/lib/video-source";
import { assertWorkspaceWriter, type Workspace } from "@/lib/workspace";

async function loadProject(ws: Workspace, projectId: string) {
  const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }));
  if (!project) throw new Error("Project not found in this workspace");
  const busy = busyStep(project);
  if (busy) throw new Error(`Please wait: ${busy} is running`);
  return project;
}

/**
 * Save edits to the extracted text and mark it confirmed; scripts are generated from confirmed text only. For a
 * video project this is where the user's own content replaces the video's caption, and where auto mode resumes.
 */
export async function confirmArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const project = await loadProject(ws, projectId);
    const title = str(fd, "title");
    const text = String(fd.get("text") ?? "").replace(/\r\n?/g, "\n").trim();
    const language = str(fd, "language") === "en" ? "en" : "vi";
    const words = countWords(text);
    const min = MIN_CONTENT_WORDS[project.sourceKind];
    if (words < min) throw new Error(project.sourceKind === "video" ? "Write what the video should say first" : `The text is too short to script (need at least ${min} words)`);
    const article = await withOrgContext(ws, (tx) => tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) }));
    if (!article) throw new Error("No article to confirm yet");
    const edited = article.text !== text || (article.title ?? "") !== title;
    await withOrgContext(ws, async (tx) => {
      await tx
        .update(schema.articles)
        .set({ text, title: title || article.title, wordCount: words, language, confirmedAt: new Date(), confirmedBy: ws.userId })
        .where(eq(schema.articles.id, article.id));
      await tx.update(schema.projects).set({ title: title || project.title, language, lastError: null }).where(eq(schema.projects.id, projectId));
    });
    await log(edited ? "article.edited" : "article.confirmed", { words, language, edited }, projectId);
    // Auto mode waited for the content of a video project: the first confirmation starts the script.
    const next = project.autoPipeline && project.sourceKind === "video" && !article.confirmedAt ? await autoAfterFetch(ws, projectId) : null;
    if (next) await inngest.send(next);
    revalidatePath(`/app/projects/${projectId}`);
    return next ? "Content confirmed; writing the script automatically…" : edited ? "Text saved and confirmed" : "Text confirmed";
  });
}

/** Re-run extraction, optionally starting with one provider (the others follow if it is blocked or fails). */
export async function refetchArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const project = await loadProject(ws, projectId);
    if (!project.url) throw new Error("This project has no link to fetch; edit its content instead");
    const m = str(fd, "method");
    const method = m === "browser_rendering" || m === "http" || m === "firecrawl" ? m : undefined;
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectFetchRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, method }));
    await log("article.refetch_requested", { method: method ?? "auto" }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return project.sourceKind === "video" ? "Downloading the video again…" : `Fetching again${method ? ` via ${method} first` : ""}…`;
  });
}

/**
 * Manual paste fallback (last link of the extraction chain). Always a direct run: there is no network fetch to
 * retry, and a paste is what is left when the providers failed, so it must not wait for the queue either.
 */
export async function pasteArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const title = str(fd, "title");
    const text = String(fd.get("text") ?? "").trim();
    if (countWords(text) < MIN_CONTENT_WORDS.article) throw new Error(`Paste at least ${MIN_CONTENT_WORDS.article} words of article text`);
    await claimDirectRun(ws, projectId, "fetch", "Lưu nội dung dán…", { allowIdle: true });
    after(() => runFetchDirect({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, manual: { title, text } }));
    await log("article.pasted", { words: countWords(text) }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return "Saving pasted text…";
  });
}

/**
 * Queue outage fallback: run the extraction inside the app with one provider (no chain, so it stays short and
 * says why it failed). Offered by <QueueRescue> when the queue has not picked the fetch up after `QUEUE_SLOW_MS`
 * or it went stale, and on the fallback card after a failed direct run. The queued event is dropped later by
 * `eventSuperseded`.
 */
export async function fetchDirect(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const method = str(fd, "method");
    if (method !== "browser_rendering" && method !== "http" && method !== "firecrawl") throw new Error("Pick a fetch method");
    const project = await claimDirectRun(ws, projectId, "fetch", `Chạy trực tiếp: ${FETCH_METHOD_LABEL[method]}`, { allowIdle: true });
    after(() => runFetchDirect({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, method }));
    await log("article.fetch_direct", { method, queuedStep: project.busyStep, queuedSince: project.busyProgress?.startedAt ?? null }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return `Fetching directly via ${FETCH_METHOD_LABEL[method]}, without the queue…`;
  });
}

/**
 * Queue outage fallback for a script that was requested (quota and article checks already done by
 * `requestScript` / auto mode, preset already on the project) but never picked up. Not offered from idle.
 */
export async function scriptDirect(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const project = await claimDirectRun(ws, projectId, "script", "Chạy trực tiếp: viết kịch bản");
    after(() => runScriptDirect({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, durationSec: project.durationSec, tone: project.tone }));
    await log("script.direct", { durationSec: project.durationSec, tone: project.tone, queuedSince: project.busyProgress?.startedAt ?? null }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return `Writing the ${project.durationSec}s script directly, without the queue…`;
  });
}

/** Generate a (new version of the) script with the chosen preset. Enforces the daily script quota. */
export async function requestScript(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    await loadProject(ws, projectId);
    const article = await withOrgContext(ws, (tx) => tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) }));
    if (!article?.confirmedAt) throw new Error("Confirm the article text first");
    const { durationSec, tone } = parsePreset(fd);
    const quota = await assertQuota(ws.userId, "scripts");
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "script", busyProgress: startProgress(), lastError: null, durationSec, tone }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectScriptRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, durationSec, tone }));
    await log("script.requested", { durationSec, tone, quotaUsed: quota.used + 1, quotaLimit: quota.limit }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return `Generating a ${durationSec}s script (${quota.used + 1}/${quota.limit} today)…`;
  });
}

export async function deleteProject(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const project = await loadProject(ws, projectId);
    if (project.ownerId !== ws.userId && !ws.isAdmin && ws.role !== "publisher" && ws.role !== "admin" && ws.role !== "owner") {
      throw new Error("Only the owner or a publisher can delete this project");
    }
    await withOrgContext(ws, (tx) => tx.delete(schema.projects).where(eq(schema.projects.id, projectId)));
    await log("project.deleted", { url: project.url, state: project.state }, projectId);
    return "Project deleted";
  });
  if (state.ok) redirect("/app");
  return state;
}

/** Phase 3: build assets + voice-over + music + timeline from the latest script (or a pinned version). */
export async function requestAssets(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const project = await loadProject(ws, projectId);
    const scriptId = str(fd, "scriptId") || undefined;
    const skipStock = fd.get("skipStock") === "on";
    const script = await withOrgContext(ws, (tx) => tx.query.scripts.findFirst({ where: eq(schema.scripts.projectId, projectId), orderBy: desc(schema.scripts.version) }));
    if (!script) throw new Error("Generate a script first");
    // The kit select is only rendered when the workspace has several kits; a changed value is a manual choice from now on.
    const kitPatch: { brandKitId?: string | null; brandKitSource?: "manual" | null; brandKitReason?: null } = {};
    if (fd.has("brandKitId")) {
      const kitId = str(fd, "brandKitId") || null;
      if (kitId !== project.brandKitId) {
        if (kitId && !(await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.id, kitId)), columns: { id: true } })))) throw new Error("That brand kit no longer exists");
        Object.assign(kitPatch, { brandKitId: kitId, brandKitSource: kitId ? "manual" : null, brandKitReason: null });
      }
    }
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "assets", busyProgress: startProgress(), lastError: null, ...kitPatch }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectAssetsRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, scriptId, skipStock }));
    await log("assets.requested", { scriptId: scriptId ?? script.id, skipStock, ...("brandKitId" in kitPatch ? { brandKitId: kitPatch.brandKitId } : {}) }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return "Building voice-over, B-roll and timeline… this takes 2–4 minutes";
  });
}

/** Phase 3: render a timeline version on Remotion Lambda. Enforces the daily render-minutes quota. `skipQa=1` forces a render past a failed QA. */
export async function requestRender(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    // Logo of this render: a channel, "kit" (the kit's own logo), or nothing posted = the project's logo channel.
    const logoChoice = fd.has("logoChannelId") ? str(fd, "logoChannelId") || "kit" : undefined;
    const r = await queueRender(ws, log, { projectId, timelineId: str(fd, "timelineId") || undefined, logoChoice, skipQa: str(fd, "skipQa") === "1" });
    revalidatePath(`/app/projects/${projectId}`);
    return `Rendering v${r.version}${r.skipQa ? " without the QA gate" : ""}${r.logoName ? ` with the ${r.logoName} logo` : ""} (${r.minutesToday}/${r.minutesLimit} render minutes today)…`;
  });
}

/** Keep a final render forever (docs/PLAN.md §9 lifecycle: pinned renders never expire). */
export async function pinRender(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    if (!["publisher", "admin", "owner"].includes(ws.role) && !ws.isAdmin) throw new Error("Only a publisher can pin renders");
    const renderId = str(fd, "renderId");
    const render = await withOrgContext(ws, (tx) => tx.query.renders.findFirst({ where: eq(schema.renders.id, renderId) }));
    if (!render?.outputPath || render.status !== "done") throw new Error("Only finished renders can be pinned");
    const pinned = !render.pinned;
    const target = pinned ? render.outputPath.replace(/^renders\//, "pinned/") : render.outputPath.replace(/^pinned\//, "renders/");
    if (target !== render.outputPath) {
      await copyObject(render.outputPath, target);
      if (render.coverPath) await copyObject(render.coverPath, render.coverPath.replace(/^(renders|pinned)\//, pinned ? "pinned/" : "renders/")).catch(() => {});
    }
    await withOrgContext(ws, (tx) =>
      tx.update(schema.renders).set({ pinned, outputPath: target, coverPath: render.coverPath?.replace(/^(renders|pinned)\//, pinned ? "pinned/" : "renders/") ?? null }).where(eq(schema.renders.id, renderId)),
    );
    await log(pinned ? "render.pinned" : "render.unpinned", { renderId }, render.projectId ?? undefined);
    if (render.projectId) revalidatePath(`/app/projects/${render.projectId}`);
    return pinned ? "Render pinned (never expires)" : "Render unpinned";
  });
}
