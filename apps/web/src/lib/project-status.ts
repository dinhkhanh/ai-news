import "server-only";
import { count, desc, inArray, max, sql } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { buildStatus, type ProjectStatus } from "@/lib/project-state";
import type { Workspace } from "@/lib/workspace";

const ACTIVE_RENDER = ["queued", "rendering", "post_processing"] as const;
const ACTIVE_PUBLICATION = ["publishing", "processing"] as const;

/**
 * Cheap status for the polling clients (docs: "listen to the run without
 * re-rendering the page"): five small grouped queries, no presigning, no
 * JSON payloads. `rev` changes when the page content would.
 */
export async function loadProjectStatuses(ws: Pick<Workspace, "userId" | "organizationId">, ids: string[]): Promise<ProjectStatus[]> {
  if (!ids.length) return [];
  return withOrgContext(ws, async (tx) => {
    const projects = await tx
      .select({ id: schema.projects.id, state: schema.projects.state, busyStep: schema.projects.busyStep, busyProgress: schema.projects.busyProgress, lastError: schema.projects.lastError, updatedAt: schema.projects.updatedAt, approvedTimelineId: schema.projects.approvedTimelineId, title: schema.projects.title })
      .from(schema.projects)
      .where(inArray(schema.projects.id, ids))
      .orderBy(desc(schema.projects.createdAt));
    if (!projects.length) return [];
    const found = projects.map((p) => p.id);
    const [scripts, timelines, renders, publications] = await Promise.all([
      tx.select({ projectId: schema.scripts.projectId, v: max(schema.scripts.version) }).from(schema.scripts).where(inArray(schema.scripts.projectId, found)).groupBy(schema.scripts.projectId),
      tx.select({ projectId: schema.timelines.projectId, v: max(schema.timelines.version) }).from(schema.timelines).where(inArray(schema.timelines.projectId, found)).groupBy(schema.timelines.projectId),
      tx
        .select({ projectId: schema.renders.projectId, total: count(), active: sql<number>`count(*) filter (where ${inArray(schema.renders.status, [...ACTIVE_RENDER])})` })
        .from(schema.renders)
        .where(inArray(schema.renders.projectId, found))
        .groupBy(schema.renders.projectId),
      tx
        .select({ projectId: schema.publications.projectId, total: count(), active: sql<number>`count(*) filter (where ${inArray(schema.publications.status, [...ACTIVE_PUBLICATION])})` })
        .from(schema.publications)
        .where(inArray(schema.publications.projectId, found))
        .groupBy(schema.publications.projectId),
    ]);
    const now = Date.now();
    return projects.map((project) => {
      const r = renders.find((x) => x.projectId === project.id);
      const p = publications.find((x) => x.projectId === project.id);
      return buildStatus(
        {
          project,
          latestScriptVersion: Number(scripts.find((x) => x.projectId === project.id)?.v ?? 0),
          latestTimelineVersion: Number(timelines.find((x) => x.projectId === project.id)?.v ?? 0),
          renders: { total: Number(r?.total ?? 0), active: Number(r?.active ?? 0) },
          publications: { total: Number(p?.total ?? 0), active: Number(p?.active ?? 0) },
        },
        now,
      );
    });
  });
}

export async function loadProjectStatus(ws: Pick<Workspace, "userId" | "organizationId">, id: string) {
  const [s] = await loadProjectStatuses(ws, [id]);
  return s ?? null;
}

/** Guards the projects.id filter: ids come from the query string. */
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

