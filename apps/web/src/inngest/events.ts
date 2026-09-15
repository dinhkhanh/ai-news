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

/** Phase 2 step 1: extract the article (or store a manual paste) for a project. */
export const projectFetchRequested = eventType("project/fetch.requested", {
  schema: z.object({
    projectId: z.string(),
    organizationId: z.string(),
    requestedBy: z.string(),
    /** Force one provider; default runs the chain browser_rendering → http → firecrawl. */
    method: z.enum(["browser_rendering", "http", "firecrawl"]).optional(),
    /** Manual paste replaces network fetching entirely. */
    manual: z.object({ title: z.string(), text: z.string() }).optional(),
  }),
});

/** Phase 2 step 2: generate a script version (+ faithfulness pass) from the confirmed article. */
export const projectScriptRequested = eventType("project/script.requested", {
  schema: z.object({
    projectId: z.string(),
    organizationId: z.string(),
    requestedBy: z.string(),
    durationSec: z.number().int().min(15).max(180),
    tone: z.string(),
    /** Pin a template version (admin testing); default = promoted. */
    templateId: z.string().optional(),
  }),
});

/** Phase 3 step 3–6: A-roll/B-roll, TTS + timings, music, audio mix → timeline version (project → composed). */
export const projectAssetsRequested = eventType("project/assets.requested", {
  schema: z.object({
    projectId: z.string(),
    organizationId: z.string(),
    requestedBy: z.string(),
    /** Script version to build from; default = latest. */
    scriptId: z.string().optional(),
    /** Skip stock search (article images / solid backgrounds only). */
    skipStock: z.boolean().optional(),
  }),
});

/** Phase 3 step 9: Remotion Lambda render of a timeline version + media Lambda post-processing and QA. */
export const projectRenderRequested = eventType("project/render.requested", {
  schema: z.object({
    projectId: z.string(),
    organizationId: z.string(),
    requestedBy: z.string(),
    /** Timeline version to render; default = latest. */
    timelineId: z.string().optional(),
  }),
});

/** Admin: run a prompt template version against the eval set. */
export const promptEvalRequested = eventType("prompt/eval.requested", {
  schema: z.object({
    evalId: z.string(),
    requestedBy: z.string(),
  }),
});
