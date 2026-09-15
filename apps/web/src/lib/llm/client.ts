import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sum } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordUsageCost } from "@/lib/activity";
import { env } from "@/lib/env";
import { readSecret } from "@/lib/vault";

/** Models per docs/PLAN.md §2. Template `model` overrides the script/faithfulness default. */
export const MODELS = {
  script: "claude-opus-5",
  faithfulness: "claude-opus-5",
  classify: "claude-haiku-4-5",
} as const;

/** USD per million tokens (Anthropic first-party rates). Cache write = 1.25x input, cache read = 0.1x input. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export function costFromUsage(model: string, u: Usage) {
  const p = PRICING[model] ?? PRICING[Object.keys(PRICING).find((k) => model.startsWith(k)) ?? ""] ?? { input: 5, output: 25 };
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return (u.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + u.output_tokens * p.output) / 1_000_000;
}

let cached: { key: string; client: Anthropic } | undefined;

async function apiKey() {
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, "anthropic") });
  if (row?.enabled && row.vaultRef) {
    const s = await readSecret(row.vaultRef);
    if (s) return { key: s, row };
  }
  const e = env().ANTHROPIC_API_KEY;
  if (e) return { key: e, row };
  throw new Error("No Anthropic API key: enable it in /admin/integrations or set ANTHROPIC_API_KEY");
}

/** Client with the admin-managed key (Vault) or the env fallback; enforces the monthly spend cap. */
export async function anthropic(): Promise<Anthropic> {
  const { key, row } = await apiKey();
  if (row?.spendCapMonthlyUsd) {
    const cap = Number(row.spendCapMonthlyUsd);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [{ usd }] = await db
      .select({ usd: sum(schema.usageCosts.costUsd) })
      .from(schema.usageCosts)
      .where(and(eq(schema.usageCosts.provider, "anthropic"), gte(schema.usageCosts.createdAt, monthStart)));
    if (cap > 0 && Number(usd ?? 0) >= cap) throw new Error(`Anthropic monthly spend cap reached ($${cap}); raise it in /admin/integrations`);
  }
  if (cached?.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 3, timeout: 10 * 60 * 1000 }) };
  return cached.client;
}

export type LlmContext = { userId?: string | null; organizationId?: string | null; projectId?: string | null; purpose: string };

/** Records tokens in/out (cache tokens in meta) as one usage_costs row and returns the cost. */
export async function recordLlmUsage(model: string, u: Usage, ctx: LlmContext, extra: Record<string, unknown> = {}) {
  const costUsd = costFromUsage(model, u);
  await recordUsageCost({
    provider: "anthropic",
    resource: model,
    units: u.input_tokens + u.output_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    unitType: "tokens",
    costUsd,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    meta: {
      purpose: ctx.purpose,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      ...extra,
    },
  });
  return costUsd;
}

/** Thrown when the model declined or the output could not be parsed; callers should not retry blindly. */
export class LlmOutputError extends Error {
  constructor(
    message: string,
    public readonly stopReason: string | null,
  ) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/**
 * True for errors that a retry cannot fix: bad request (schema/params), no
 * credits, bad key, missing permissions, unknown model. Rate limits and 5xx
 * stay retryable (the SDK already retries those 3 times).
 */
export function isPermanentLlmError(e: unknown) {
  if (e instanceof LlmOutputError) return e.stopReason === "refusal";
  return (
    e instanceof Anthropic.BadRequestError ||
    e instanceof Anthropic.AuthenticationError ||
    e instanceof Anthropic.PermissionDeniedError ||
    e instanceof Anthropic.NotFoundError ||
    e instanceof Anthropic.UnprocessableEntityError
  );
}
