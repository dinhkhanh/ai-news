import { eventType } from "inngest";
import { z } from "zod";

/** Event catalogue. Every pipeline step is a separate event so any step can be re-run. */

export const activityLogged = eventType("activity/logged", {
  schema: z.object({
    actorId: z.string().nullable().optional(),
    organizationId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const usageCostRecorded = eventType("usage/cost.recorded", {
  schema: z.object({
    provider: z.string(),
    resource: z.string().optional(),
    units: z.number(),
    unitType: z.string(),
    costUsd: z.number(),
    userId: z.string().nullable().optional(),
    organizationId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    renderId: z.string().nullable().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Phase 1 end-to-end check: Remotion Lambda → R2 → media Lambda QA probe. */
export const testRenderRequested = eventType("render/test.requested", {
  schema: z.object({
    requestedBy: z.string(),
    organizationId: z.string(),
    title: z.string().optional(),
    durationSec: z.number().int().min(3).max(60).optional(),
  }),
});

/** Placeholder for phase 2: kicks off the pipeline for a project. */
export const projectPipelineRequested = eventType("project/pipeline.requested", {
  schema: z.object({
    projectId: z.string(),
    organizationId: z.string(),
    requestedBy: z.string(),
    fromStep: z.enum(["fetch", "script", "assets", "tts", "captions", "music", "compose", "render", "publish"]).optional(),
  }),
});
