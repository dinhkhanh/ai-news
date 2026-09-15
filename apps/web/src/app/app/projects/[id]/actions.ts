"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectFetchRequested, projectScriptRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { countWords } from "@/lib/fetch/readability";
import { parsePreset } from "@/lib/presets";
import { busyStep } from "@/lib/project-state";
import { assertQuota } from "@/lib/quota";
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
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", lastError: null }).where(eq(schema.projects.id, projectId)));
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
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "fetch", lastError: null }).where(eq(schema.projects.id, projectId)));
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
    await withOrgContext(ws, (tx) => tx.update(schema.projects).set({ busyStep: "script", lastError: null, durationSec, tone }).where(eq(schema.projects.id, projectId)));
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
