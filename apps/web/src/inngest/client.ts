import { Inngest } from "inngest";

/**
 * Inngest v4 client. Signing/event keys come from INNGEST_SIGNING_KEY /
 * INNGEST_EVENT_KEY; local dev uses INNGEST_DEV=1 with `pnpm inngest:dev`.
 * Checkpointing must stay below the route's maxDuration (see api/inngest/route.ts).
 */
export const inngest = new Inngest({
  id: "ai-news",
  // Dev mode skips request signature checks. Never let a stray INNGEST_DEV switch that on in production.
  isDev: process.env.NODE_ENV !== "production" && !!process.env.INNGEST_DEV && process.env.INNGEST_DEV !== "0",
  checkpointing: { maxRuntime: "250s" },
});
