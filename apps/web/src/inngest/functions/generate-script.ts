import { inngest } from "../client";
import { projectScriptRequested } from "../events";
import { failScript, scriptPipeline } from "@/lib/pipeline/script";
import { durableSteps } from "@/lib/pipeline/steps";

/**
 * Pipeline step 2 (docs/PLAN.md §4.2). The work itself is `scriptPipeline`
 * (src/lib/pipeline/script.ts), shared with the direct run the project page
 * offers when this queue does not pick the step up. An event that is older than
 * the newest script version ends in the first step without touching the project.
 */
export const generateScriptFn = inngest.createFunction(
  {
    id: "generate-script",
    triggers: [projectScriptRequested],
    retries: 2,
    /** Global cap 5 = Inngest free-tier concurrency limit; per-project lock stays at 1. */
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 5 }],
    onFailure: async ({ event }) => failScript(event.data.event.data, event.data.error?.message ?? "script generation failed"),
  },
  async ({ event, step }) => {
    const { next, result } = await scriptPipeline({ ...event.data, sentAt: event.ts }, durableSteps(step));
    if (next) await step.sendEvent("auto-assets", next);
    return result;
  },
);
