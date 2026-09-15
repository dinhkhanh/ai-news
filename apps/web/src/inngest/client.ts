import { Inngest } from "inngest";

/**
 * Inngest v4 client. Signing/event keys come from INNGEST_SIGNING_KEY /
 * INNGEST_EVENT_KEY; local dev uses INNGEST_DEV=1 with `pnpm inngest:dev`.
 * Checkpointing must stay below the route's maxDuration (see api/inngest/route.ts).
 */
export const inngest = new Inngest({
  id: "ai-news",
  checkpointing: { maxRuntime: "250s" },
});
