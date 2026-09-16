"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectAssetsRequested, projectFetchRequested, projectRenderRequested, projectScriptRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { countWords } from "@/lib/fetch/readability";
import { parsePreset } from "@/lib/presets";
import { busyStep, startProgress } from "@/lib/project-state";
import { assertQuota } from "@/lib/quota";
import { copyObject } from "@/lib/r2";
import { assertWorkspaceWriter, type Workspace } from "@/lib/workspace";

async function loadProject(ws: Workspace, projectId: string) {
  const project = await withOrgContext(ws, (tx) => tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }));
  if (!project) throw new Error("Project not found in this workspace");
  const busy = busyStep(project);
  if (busy) throw new Error(`Please wait: ${busy} is running`);
  return project;
}

/** Save edits to the extracted text and mark it confirmed; scripts are generated from confirmed text only. */
export async function confirmArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    const project = await loadProject(ws, projectId);
    const title = str(fd, "title");
    const text = String(fd.get("text") ?? "").replace(/\r\n?/g, "\n").trim();
    const language = str(fd, "language") === "en" ? "en" : "vi";
    const words = countWords(text);
    if (words < 40) throw new Error("The article text is too short to script (need at least 40 words)");
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
    revalidatePath(`/app/projects/${projectId}`);
    return edited ? "Text saved and confirmed" : "Text confirmed";
  });
}

/** Re-run extraction, optionally forcing one provider. */
export async function refetchArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    await loadProject(ws, projectId);
    const m = str(fd, "method");
    const method = m === "browser_rendering" || m === "http" || m === "firecrawl" ? m : undefined;
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectFetchRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, method }));
    await log("article.refetch_requested", { method: method ?? "auto" }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return `Fetching again${method ? ` via ${method}` : ""}…`;
  });
}

/** Manual paste fallback (last link of the extraction chain). */
export async function pasteArticle(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    await loadProject(ws, projectId);
    const title = str(fd, "title");
    const text = String(fd.get("text") ?? "").trim();
    if (countWords(text) < 40) throw new Error("Paste at least 40 words of article text");
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectFetchRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, manual: { title, text } }));
    await log("article.pasted", { words: countWords(text) }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return "Saving pasted text…";
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
    await loadProject(ws, projectId);
    const scriptId = str(fd, "scriptId") || undefined;
    const skipStock = fd.get("skipStock") === "on";
    const script = await withOrgContext(ws, (tx) => tx.query.scripts.findFirst({ where: eq(schema.scripts.projectId, projectId), orderBy: desc(schema.scripts.version) }));
    if (!script) throw new Error("Generate a script first");
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "assets", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectAssetsRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, scriptId, skipStock }));
    await log("assets.requested", { scriptId: scriptId ?? script.id, skipStock }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return "Building voice-over, B-roll and timeline… this takes 2–4 minutes";
  });
}

/** Phase 3: render a timeline version on Remotion Lambda. Enforces the daily render-minutes quota. */
export async function requestRender(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const projectId = str(fd, "projectId");
    await loadProject(ws, projectId);
    const timelineId = str(fd, "timelineId") || undefined;
    const timeline = timelineId
      ? await withOrgContext(ws, (tx) => tx.query.timelines.findFirst({ where: and(eq(schema.timelines.projectId, projectId), eq(schema.timelines.id, timelineId)) }))
      : await withOrgContext(ws, (tx) => tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, projectId), orderBy: desc(schema.timelines.version) }));
    if (!timeline) throw new Error("Build the timeline first");
    const minutes = Number(timeline.durationSec ?? 60) / 60;
    const quota = await assertQuota(ws.userId, "render_minutes");
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "render", busyProgress: startProgress(), lastError: null }).where(eq(schema.projects.id, projectId)));
    await inngest.send(projectRenderRequested.create({ projectId, organizationId: ws.organizationId, requestedBy: ws.userId, timelineId: timeline.id }));
    await log("quota.render_minutes", { minutes: Math.round(minutes * 100) / 100, timelineId: timeline.id }, projectId);
    await log("render.requested", { timelineId: timeline.id, version: timeline.version, quotaUsed: quota.used, quotaLimit: quota.limit }, projectId);
    revalidatePath(`/app/projects/${projectId}`);
    return `Rendering v${timeline.version} (${Math.ceil(quota.used + minutes)}/${quota.limit} render minutes today)…`;
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
