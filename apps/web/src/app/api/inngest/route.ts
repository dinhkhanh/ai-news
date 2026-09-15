import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

/** Vercel Fluid compute: allow long steps; client checkpointing.maxRuntime stays below this. */
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
