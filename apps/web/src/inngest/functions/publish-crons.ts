import { cron } from "inngest";
import { inngest } from "../client";
import { CRON_JOBS } from "@/lib/cron-jobs";

/**
 * The recurring jobs themselves are plain functions in `src/lib/cron-jobs.ts`, also reachable over HTTP at
 * `/api/cron/<job>`. These three triggers keep them running on Inngest until an external scheduler is live
 * (infra/supabase/cron.sql); then remove them here and from `./index.ts`, because a job does not need two
 * schedulers, and a cron on Inngest stops with Inngest (2026-09-18: no timers for the length of the outage).
 * No steps: the jobs isolate their own items, and every step would count towards the plan's executions
 * (the 10-minute poll alone is ~4,300 runs a month).
 */

/** Publications still processing on the platform: re-check every 10 minutes (docs/PLAN.md §4.10 "Poll processing status"). */
export const pollPublicationsFn = inngest.createFunction(
  { id: "poll-processing-publications", triggers: [cron(CRON_JOBS["poll-publications"].schedule)], retries: 0, concurrency: [{ limit: 1 }] },
  async () => CRON_JOBS["poll-publications"].run(),
);

/** Daily analytics pull at 02:30 Asia/Ho_Chi_Minh (19:30 UTC) for every channel with published posts. */
export const pullAnalyticsFn = inngest.createFunction(
  { id: "pull-publication-analytics", triggers: [cron(CRON_JOBS["pull-analytics"].schedule)], retries: 0, concurrency: [{ limit: 1 }] },
  async () => CRON_JOBS["pull-analytics"].run(),
);

/** Token health every 6 hours (docs/PLAN.md §7 "cron refresh, admin alert on failure"). */
export const refreshChannelTokensFn = inngest.createFunction(
  { id: "refresh-channel-tokens", triggers: [cron(CRON_JOBS["refresh-channel-tokens"].schedule)], retries: 0, concurrency: [{ limit: 1 }] },
  async () => CRON_JOBS["refresh-channel-tokens"].run(),
);
