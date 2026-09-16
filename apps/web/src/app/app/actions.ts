"use server";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectFetchRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { parsePreset } from "@/lib/presets";
import { assertQuota } from "@/lib/quota";
import { canonicalizeUrl, isPrivateHost } from "@/lib/url";
import { assertWorkspaceWriter } from "@/lib/workspace";

/** Create a project from a URL, check duplicates org-wide, and start the fetch step. */
export async function createProject(_: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const url = canonicalizeUrl(str(fd, "url"));
    if (isPrivateHost(url)) throw new Error("That address is not a public website");
    const { durationSec, tone } = parsePreset(fd);
    const force = fd.get("force") === "on";
    const auto = fd.get("auto") === "on";
    // Auto mode will spend a script + a render on this user's behalf: fail fast if today's quota is already gone.
    if (auto) await Promise.all([assertQuota(ws.userId, "scripts"), assertQuota(ws.userId, "render_minutes")]);

    const existing = await withOrgContext(ws, (tx) =>
      tx.query.projects.findFirst({ where: and(eq(schema.projects.organizationId, ws.organizationId), eq(schema.projects.canonicalUrl, url)) }),
    );
    if (existing && !force) {
      target = `/app/projects/${existing.id}?duplicate=1`;
      return `This article already has a project (${existing.state}). Opening it; tick "create anyway" to start another.`;
    }

    const [project] = await withOrgContext(ws, (tx) =>
      tx
        .insert(schema.projects)
        .values({ organizationId: ws.organizationId, ownerId: ws.userId, url, canonicalUrl: url, durationSec, tone, autoPipeline: auto, busyStep: "fetch" })
        .returning({ id: schema.projects.id }),
    );
    await log("project.created", { url, durationSec, tone, auto, duplicateOf: existing?.id ?? null }, project.id);
    await inngest.send(projectFetchRequested.create({ projectId: project.id, organizationId: ws.organizationId, requestedBy: ws.userId }));
    target = `/app/projects/${project.id}`;
    return auto ? "Project created; running fetch → script → build → render automatically…" : "Project created; fetching the article…";
  });
  if (target) redirect(target);
  return state;
}
