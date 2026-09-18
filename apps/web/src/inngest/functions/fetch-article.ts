import { inngest } from "../client";
import { projectFetchRequested } from "../events";
import { failFetch, fetchPipeline } from "@/lib/pipeline/fetch";
import { durableSteps } from "@/lib/pipeline/steps";

/**
 * Pipeline step 1 (docs/PLAN.md §4.1). The work itself is `fetchPipeline`
 * (src/lib/pipeline/fetch.ts), shared with the direct run the project page
 * offers when this queue does not pick the step up. An event that is older than
 * the stored article (a direct run or an earlier duplicate got there first) ends
 * in the first step without touching the project.
 */
export const fetchArticleFn = inngest.createFunction(
  {
    id: "fetch-article",
    triggers: [projectFetchRequested],
    retries: 1,
    /** Global cap 5 = Inngest free-tier concurrency limit; per-project lock stays at 1. */
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 5 }],
    onFailure: async ({ event }) => failFetch(event.data.event.data, event.data.error?.message ?? "fetch failed"),
  },
  async ({ event, step }) => {
    const { next, result } = await fetchPipeline({ ...event.data, sentAt: event.ts }, durableSteps(step));
    if (next) await step.sendEvent("auto-script", next);
    return result;
  },
);
