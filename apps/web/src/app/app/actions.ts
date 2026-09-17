"use server";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectFetchRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { channelLogo } from "@/lib/media/logo";
import { parsePreset } from "@/lib/presets";
import { startProgress } from "@/lib/project-state";
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
    // Empty = let the article decide after the fetch (src/lib/media/brand.ts `chooseBrandKit`).
    const kitId = str(fd, "brandKitId");
    const kit = kitId ? await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.id, kitId)), columns: { id: true, name: true } })) : null;
    if (kitId && !kit) throw new Error("That brand kit no longer exists");
    // Whose logo the videos carry (brand kits are shared across channels); empty = the kit's own logo.
    const logoChannelId = str(fd, "logoChannelId");
    const logoChannel = await channelLogo(ws, logoChannelId);
    if (logoChannelId && !logoChannel) throw new Error("That channel has no logo (any more)");
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
        .values({ organizationId: ws.organizationId, ownerId: ws.userId, url, canonicalUrl: url, durationSec, tone, autoPipeline: auto, brandKitId: kit?.id ?? null, brandKitSource: kit ? "manual" : null, logoChannelId: logoChannel?.id ?? null, busyStep: "fetch", busyProgress: startProgress() })
        .returning({ id: schema.projects.id }),
    );
    await log("project.created", { url, durationSec, tone, auto, brandKit: kit?.name ?? "auto", logoChannel: logoChannel?.name ?? null, duplicateOf: existing?.id ?? null }, project.id);
    await inngest.send(projectFetchRequested.create({ projectId: project.id, organizationId: ws.organizationId, requestedBy: ws.userId }));
    target = `/app/projects/${project.id}`;
    return auto ? "Project created; running fetch → script → build → render automatically…" : "Project created; fetching the article…";
  });
  if (target) redirect(target);
  return state;
}
