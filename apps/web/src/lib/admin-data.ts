import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type { Platform } from "@/lib/publish/platforms";

/**
 * Admin CMS reads. Every loader is one round-trip to a SECURITY DEFINER function from
 * migration 0013 (0010 for the overview) that returns the whole page as one jsonb document,
 * instead of several queries and a four-statement service-context transaction per RLS table.
 * jsonb has no dates: timestamps arrive as ISO strings and are revived here.
 * Raw `sql` params skip Drizzle's column mappers, so dates go in as text and are cast.
 */
async function call<T>(query: SQL): Promise<T> {
  const rows = await db.execute<{ data: T }>(query);
  return rows[0].data;
}

const date = (v: string | null) => (v ? new Date(v) : null);

type Revived<T, K extends keyof T> = Omit<T, K> & { [P in K]: null extends T[P] ? Date | null : Date };

/** Turns the listed ISO-string fields of every row into Dates. */
function revive<T extends Record<string, unknown>, K extends keyof T>(rows: T[], ...keys: K[]): Array<Revived<T, K>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of keys) out[k as string] = date(r[k] as string | null);
    return out as Revived<T, K>;
  });
}

export type AdminMember = { organizationId: string; userId: string; role: string; email: string; name: string };

// ── analytics ────────────────────────────────────────────────────────────────
export type AdminAnalytics = {
  produced: number;
  published: number;
  byPlatform: Array<{ platform: Platform; posts: number; views: number; likes: number; comments: number; shares: number }>;
  byDay: Array<{ day: string; posts: number; views: number }>;
  byStatus: Record<string, number>;
  ytUnitsToday: number;
  topPosts: Array<{ id: string; platform: Platform; url: string | null; title: string | null; views: number | null }>;
  channels: number;
  unhealthyChannels: number;
};

export function loadAdminAnalytics(since: Date, dayStart: Date) {
  return call<AdminAnalytics>(sql`select admin_analytics_stats(${since.toISOString()}::timestamptz, ${dayStart.toISOString()}::timestamptz) as data`);
}

// ── channels ─────────────────────────────────────────────────────────────────
type RawChannel = {
  id: string;
  organizationId: string;
  platform: Platform;
  externalId: string;
  name: string;
  avatarUrl: string | null;
  logoPath: string | null;
  hasToken: boolean;
  scopes: string[];
  expiresAt: string | null;
  healthy: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
  enabled: boolean;
};

export async function loadAdminChannels() {
  const d = await call<{
    orgs: Array<{ id: string; name: string; kind: string }>;
    channels: RawChannel[];
    members: AdminMember[];
    grants: Array<{ id: string; channelId: string; userId: string }>;
    metaReady: boolean;
    tiktokReady: boolean;
    flags: Record<string, boolean>;
  }>(sql`select admin_channels_page() as data`);
  return { ...d, channels: revive(d.channels, "expiresAt", "lastCheckedAt") };
}

// ── workspaces / quotas ──────────────────────────────────────────────────────
export function loadAdminWorkspaces() {
  return call<{ orgs: Array<{ id: string; name: string; kind: string }>; members: AdminMember[]; users: Array<{ id: string; email: string }> }>(
    sql`select admin_workspaces_page() as data`,
  );
}

export function loadAdminQuotas() {
  return call<{
    quotas: Array<{ id: string; scope: "user" | "org"; scopeId: string; resource: string; dailyLimit: number }>;
    users: Array<{ id: string; email: string }>;
    orgs: Array<{ id: string; name: string }>;
  }>(sql`select admin_quotas_page() as data`);
}

// ── integrations ─────────────────────────────────────────────────────────────
type RawIntegration = {
  provider: string;
  hasSecret: boolean;
  enabled: boolean;
  spendCapMonthlyUsd: string | null;
  creditsRemaining: number | null;
  updatedAt: string;
  /** Masked in the database; null when no secret is set. */
  preview: string | null;
};

export async function loadAdminIntegrations() {
  const d = await call<{ integrations: RawIntegration[]; flags: Record<string, boolean> }>(sql`select admin_integrations_page() as data`);
  return { integrations: revive(d.integrations, "updatedAt"), flags: d.flags };
}

// ── evals ────────────────────────────────────────────────────────────────────
type RawEvalRun = {
  id: string;
  status: string;
  durationSec: number;
  tone: string;
  articleCount: number;
  summary: Record<string, unknown> | null;
  costUsd: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  purpose: string;
  language: string;
  version: number;
  templateId: string;
};

/** `results` is only loaded for the run on screen (`run` if it is among the latest 30, else the newest). */
export async function loadAdminEvals(run: string | undefined) {
  const runId = run && /^[0-9a-f-]{36}$/i.test(run) ? run : null;
  const d = await call<{
    articles: Array<{
      id: string;
      language: "vi" | "en";
      title: string;
      sourceUrl: string | null;
      notes: string | null;
      expectations: { mustMention?: string[]; mustNotMention?: string[] };
      enabled: boolean;
      words: number;
    }>;
    runs: RawEvalRun[];
    activeId: string | null;
    activeResults: Array<Record<string, unknown>> | null;
    recentProjects: Array<{ id: string; title: string | null; url: string; language: string; state: string }>;
  }>(sql`select admin_evals_page(${runId}::uuid) as data`);
  const runs = revive(d.runs, "createdAt", "finishedAt");
  const found = runs.find((r) => r.id === d.activeId);
  return { articles: d.articles, runs, recentProjects: d.recentProjects, active: found ? { ...found, results: d.activeResults ?? [] } : null };
}

// ── health / activity ────────────────────────────────────────────────────────
type RawRender = {
  id: string;
  createdAt: string;
  status: string;
  durationSec: string | null;
  costUsd: string | null;
  qaJson: Record<string, unknown> | null;
  outputPath: string | null;
  error: string | null;
};

export async function loadAdminRecentRenders(limit: number) {
  return revive(await call<RawRender[]>(sql`select admin_recent_renders(${limit}::int) as data`), "createdAt");
}

type RawActivity = {
  id: number;
  type: string;
  actorEmail: string | null;
  impersonatorId: string | null;
  organizationId: string | null;
  projectId: string | null;
  payload: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

export async function loadAdminActivity(opts: { type?: string; actor?: string; limit: number; offset: number }) {
  const rows = await call<RawActivity[]>(
    sql`select admin_activity_page(${opts.type || null}::text, ${opts.actor || null}::text, ${opts.limit}::int, ${opts.offset}::int) as data`,
  );
  return revive(rows, "createdAt");
}
