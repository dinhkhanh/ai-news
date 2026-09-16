import type { schema } from "@/db";
import type { ChannelToken } from "./oauth";
import type { Analytics, Platform } from "./platforms";

export type ChannelRow = typeof schema.channels.$inferSelect;
export type PublicationRow = typeof schema.publications.$inferSelect;

export type PublicationMetadata = {
  title: string;
  description: string;
  hashtags: string[];
  /** Per-platform handles kept while processing (Instagram container id, TikTok publish id, Facebook video id…). */
  handles?: Record<string, unknown>;
  /** What was actually sent (after platform-specific adjustments such as TikTok privacy fallback). */
  sent?: Record<string, unknown>;
};

export type PublishJob = {
  publication: PublicationRow & { metadata: PublicationMetadata };
  channel: ChannelRow;
  token: ChannelToken;
  video: { key: string; sizeBytes: number; durationSec: number; presignedUrl: string; coverUrl: string | null };
  language: "vi" | "en";
};

export type StartResult = {
  state: "processing" | "published";
  postId: string | null;
  url: string | null;
  handles: Record<string, unknown>;
  sent: Record<string, unknown>;
  /** YouTube Data API units consumed (docs/PLAN.md §7). */
  quotaUnits?: number;
};

export type CheckResult = {
  state: "processing" | "published" | "failed";
  postId?: string | null;
  url?: string | null;
  error?: string;
  handles?: Record<string, unknown>;
  quotaUnits?: number;
  raw?: unknown;
};

export type PlatformClient = {
  platform: Platform;
  start(job: PublishJob): Promise<StartResult>;
  check(job: Pick<PublishJob, "publication" | "channel" | "token">): Promise<CheckResult>;
  analytics(channel: ChannelRow, token: ChannelToken, postIds: string[]): Promise<{ byPost: Record<string, Analytics>; quotaUnits?: number }>;
};

export class PlatformError extends Error {
  constructor(
    message: string,
    /** Permanent errors (bad metadata, revoked token, rejected video) must not be retried. */
    public readonly permanent = false,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export async function readJson<T>(res: Response, what: string, permanentStatuses: number[] = [400, 401, 403, 404]): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string; code?: unknown; errors?: Array<{ reason?: string }> } | string; error_description?: string; message?: string };
    const msg = typeof b.error === "string" ? `${b.error} ${b.error_description ?? ""}`.trim() : (b.error?.message ?? b.message ?? text.slice(0, 300));
    throw new PlatformError(`${what} failed (${res.status}): ${msg}`, permanentStatuses.includes(res.status), body);
  }
  return body as T;
}
