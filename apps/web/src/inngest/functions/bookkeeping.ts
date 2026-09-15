import { inngest } from "../client";
import { activityLogged, usageCostRecorded } from "../events";
import { logActivity, recordUsageCost } from "@/lib/activity";

/** Lets background jobs append to the activity log without a DB handle in every step. */
export const writeActivityEvent = inngest.createFunction(
  { id: "write-activity-event", triggers: [activityLogged], retries: 3 },
  async ({ event, step }) => {
    await step.run("insert", () => logActivity(event.data));
    return { ok: true };
  },
);

export const writeUsageCost = inngest.createFunction(
  { id: "write-usage-cost", triggers: [usageCostRecorded], retries: 3 },
  async ({ event, step }) => {
    await step.run("insert", () => recordUsageCost(event.data));
    return { ok: true };
  },
);
