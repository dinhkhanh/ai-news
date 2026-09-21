/**
 * Application tables (docs/PLAN.md §5). All org-scoped tables carry
 * organization_id and are protected by RLS (see migrations/*_rls.sql).
 */
import { sql } from "drizzle-orm";
import type { LogoMotion } from "@ai-news/video/schema";
import type { BusyProgress } from "@/lib/project-state";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

// ---------- enums ----------

export const projectStateEnum = pgEnum("project_state", [
  "created",
  "fetched",
  "scripted",
  "assets_ready",
  "composed",
  "in_review",
  "approved",
  "rendered",
  "published",
  "failed",
]);

export const languageEnum = pgEnum("language", ["vi", "en"]);

export const platformEnum = pgEnum("platform", ["youtube", "facebook", "instagram", "tiktok"]);

export const assetOriginEnum = pgEnum("asset_origin", [
  "article",
  "stock",
  "ai",
  "web_video",
  "upload",
  "library",
]);

export const renderStatusEnum = pgEnum("render_status", [
  "queued",
  "rendering",
  "post_processing",
  "qa_failed",
  "done",
  "failed",
]);

export const publicationStatusEnum = pgEnum("publication_status", [
  "draft",
  "scheduled",
  "publishing",
  "processing",
  "published",
  "failed",
  "cancelled",
]);

export const quotaScopeEnum = pgEnum("quota_scope", ["user", "org"]);

// ---------- helpers ----------

const orgId = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- platform-level (not org-scoped) ----------

export const allowedDomains = pgTable("allowed_domains", {
  domain: text("domain").primaryKey(),
  note: text("note"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

/** Shared third-party API keys. Secret lives in Supabase Vault; we keep the vault secret id. */
export const integrations = pgTable("integrations", {
  provider: text("provider").primaryKey(), // anthropic | pexels | pixabay | mubert | firecrawl | cloudflare_browser | ...
  vaultRef: uuid("vault_ref"),
  enabled: boolean("enabled").notNull().default(false),
  spendCapMonthlyUsd: numeric("spend_cap_monthly_usd", { precision: 10, scale: 2 }),
  creditsRemaining: integer("credits_remaining"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").notNull(), // script | faithfulness | metadata | rank | language_detect | sensitive_topic
    language: languageEnum("language").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    model: text("model"),
    promoted: boolean("promoted").notNull().default(false),
    notes: text("notes"),
    evalJson: jsonb("eval_json").$type<Record<string, unknown>>(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("prompt_templates_purpose_lang_version_uidx").on(t.purpose, t.language, t.version),
    index("prompt_templates_promoted_idx").on(t.purpose, t.language, t.promoted),
  ],
);

/** Admin-curated eval set (docs/PLAN.md §9 "20-article eval set"). Platform-level, not org-scoped. */
export const evalArticles = pgTable(
  "eval_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    language: languageEnum("language").notNull(),
    title: text("title").notNull(),
    sourceUrl: text("source_url"),
    text: text("text").notNull(),
    notes: text("notes"),
    /** Optional expectations checked by the eval run, e.g. facts that must appear. */
    expectations: jsonb("expectations").$type<{ mustMention?: string[]; mustNotMention?: string[] }>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("eval_articles_lang_idx").on(t.language, t.enabled)],
);

export const evalStatusEnum = pgEnum("eval_status", ["queued", "running", "done", "failed"]);

/** One eval run of a prompt template version against the eval set. */
export const promptEvals = pgTable(
  "prompt_evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => promptTemplates.id, { onDelete: "cascade" }),
    status: evalStatusEnum("status").notNull().default("queued"),
    durationSec: integer("duration_sec").notNull().default(60),
    tone: text("tone").notNull().default("news"),
    articleCount: integer("article_count").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    results: jsonb("results").$type<Array<Record<string, unknown>>>().notNull().default([]),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    error: text("error"),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("prompt_evals_template_idx").on(t.templateId, t.createdAt)],
);

export const quotas = pgTable(
  "quotas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: quotaScopeEnum("scope").notNull(),
    /** user id / org id, or "*" for the default of that scope */
    scopeId: text("scope_id").notNull().default("*"),
    resource: text("resource").notNull(), // scripts | ai_media | render_minutes | publishes
    dailyLimit: integer("daily_limit").notNull(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("quotas_scope_uidx").on(t.scope, t.scopeId, t.resource)],
);

export const musicLibrary = pgTable("music_library", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  r2Path: text("r2_path").notNull(),
  moodTags: text("mood_tags").array().notNull().default(sql`'{}'::text[]`),
  durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
  licence: text("licence").notNull(),
  licenceUrl: text("licence_url"),
  loudnessLufs: numeric("loudness_lufs", { precision: 5, scale: 2 }),
  uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// ---------- org-scoped ----------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** The article or video page; null for a `text` project (content typed in by the user, no link). */
    url: text("url"),
    canonicalUrl: text("canonical_url"),
    /**
     * What the project is made from: `article` = a news page (fetch chain), `video` = a video page (YouTube, TikTok,
     * Facebook…): its file is downloaded as the footage and the user writes the content, `text` = content typed in at creation.
     */
    sourceKind: text("source_kind").$type<"article" | "video" | "text">().notNull().default("article"),
    /** `video` projects: the downloaded source video (a `web_video` asset); every shot of the build is cut from it. */
    sourceVideoAssetId: uuid("source_video_asset_id").references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
    title: text("title"),
    language: languageEnum("language").notNull().default("vi"),
    state: projectStateEnum("state").notNull().default("created"),
    aiDisclosure: boolean("ai_disclosure").notNull().default(false),
    sensitiveTopic: boolean("sensitive_topic").notNull().default(false),
    /** Political story (classified at fetch): the build and the editor never use stock footage or AI stills for it. */
    political: boolean("political").notNull().default(false),
    /** Only value in use: `DIRECT_RUN_ID` ("direct") after a failed direct fetch (src/lib/pipeline/fetch.ts `failFetch`); null otherwise. */
    inngestRunId: text("inngest_run_id"),
    /** Pipeline step currently running for this project (fetch | script | ...), null when idle. */
    busyStep: text("busy_step"),
    /** Live progress of the running step, written by the Inngest function (src/lib/progress.ts); null when idle. */
    busyProgress: jsonb("busy_progress").$type<BusyProgress>(),
    /** Script presets (docs/PLAN.md §4.2): target length and tone. */
    durationSec: integer("duration_sec").notNull().default(60),
    tone: text("tone").notNull().default("news"),
    /** Auto mode: after each pipeline step the next one starts without a human click (fetch → script → assets → render). */
    autoPipeline: boolean("auto_pipeline").notNull().default(false),
    /**
     * Brand kit of the next build. `brand_kit_source`: `manual` = picked by a person (never overwritten),
     * `auto` = matched to the article after the fetch (`brand_kit_reason` says why); null = workspace default.
     */
    brandKitId: uuid("brand_kit_id").references((): AnyPgColumn => brandKits.id, { onDelete: "set null" }),
    brandKitSource: text("brand_kit_source").$type<"manual" | "auto">(),
    brandKitReason: text("brand_kit_reason"),
    /**
     * Whose logo this project's videos carry: the kit is shared by every channel, the logo is the channel's
     * (`channels.logo_path`). Null, or a channel without a logo = the kit's own logo. A render may pick another channel.
     */
    logoChannelId: uuid("logo_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
    lockVersion: integer("lock_version").notNull().default(0),
    lastError: text("last_error"),
    /** Approval flow (docs/PLAN.md §4.8): the timeline version a publisher approved; cleared by any later edit. */
    approvedTimelineId: uuid("approved_timeline_id"),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_org_idx").on(t.organizationId, t.createdAt),
    index("projects_owner_idx").on(t.ownerId),
    index("projects_canonical_idx").on(t.organizationId, t.canonicalUrl),
  ],
);

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null for content typed in without a link (`text` projects). */
    canonicalUrl: text("canonical_url"),
    title: text("title"),
    author: text("author"),
    siteName: text("site_name"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    language: languageEnum("language"),
    text: text("text").notNull(),
    excerpt: text("excerpt"),
    images: jsonb("images").$type<Array<{ url: string; alt?: string; width?: number; height?: number }>>().notNull().default([]),
    snapshotPath: text("snapshot_path"),
    screenshotPath: text("screenshot_path"),
    fetchMethod: text("fetch_method"), // browser_rendering | http | firecrawl | manual | video
    flags: jsonb("flags").$type<{ paywall?: boolean; liveBlog?: boolean; videoOnly?: boolean; short?: boolean }>().notNull().default({}),
    wordCount: integer("word_count").notNull().default(0),
    /** Set when the user confirms (or edits) the extracted text; scripts are generated from confirmed text only. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("articles_project_idx").on(t.projectId)],
);

export const scripts = pgTable(
  "scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    scenesJson: jsonb("scenes_json").$type<Record<string, unknown>>().notNull(),
    templateId: uuid("template_id").references(() => promptTemplates.id, { onDelete: "set null" }),
    templateVersion: integer("template_version"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    faithfulnessJson: jsonb("faithfulness_json").$type<Record<string, unknown>>(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scripts_project_version_uidx").on(t.projectId, t.version)],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    origin: assetOriginEnum("origin").notNull(),
    provider: text("provider"), // pexels | pixabay | veo | imagen | article | yt-dlp | upload
    providerId: text("provider_id"),
    licence: text("licence"),
    sourceUrl: text("source_url"),
    r2Path: text("r2_path").notNull(),
    thumbnailPath: text("thumbnail_path"),
    hash: text("hash"),
    mime: text("mime"),
    width: integer("width"),
    height: integer("height"),
    durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    searchTerm: text("search_term"),
    rankScore: numeric("rank_score", { precision: 5, scale: 2 }),
    /** Scene this candidate was fetched for (phase 3); null for project-wide assets (A-roll pool, music). */
    sceneId: text("scene_id"),
    /** Chosen for the timeline; other rows for the scene are alternates (phase 4 swap). */
    selected: boolean("selected").notNull().default(false),
    /** Remote preview image (not stored in R2) for the UI and the ranking model. */
    thumbnailUrl: text("thumbnail_url"),
    attribution: text("attribution"),
    licenceUrl: text("licence_url"),
    rankReason: text("rank_reason"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_org_hash_idx").on(t.organizationId, t.hash),
    index("assets_project_idx").on(t.projectId),
    index("assets_project_scene_idx").on(t.projectId, t.sceneId),
  ],
);

export const timelines = pgTable(
  "timelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    json: jsonb("json").$type<Record<string, unknown>>().notNull(),
    scriptId: uuid("script_id").references(() => scripts.id, { onDelete: "set null" }),
    durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
    /** Per-scene provenance (voice timing method, chosen asset, music) plus the editor document (`doc`) for the review UI. */
    buildJson: jsonb("build_json").$type<Record<string, unknown>>().notNull().default({}),
    note: text("note"),
    /** Version this one was edited from (phase 4); null for pipeline builds. */
    parentId: uuid("parent_id"),
    /** built (pipeline) | edited (editor save) | regenerated (one scene's B-roll/voice/music re-done). */
    kind: text("kind").notNull().default("built"),
    /** Human-readable change list versus the parent version. */
    changes: jsonb("changes").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("timelines_project_version_uidx").on(t.projectId, t.version)],
);

/** Review comments on a project, optionally anchored to a scene and a timestamp (docs/PLAN.md §4.7). */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    timelineId: uuid("timeline_id").references(() => timelines.id, { onDelete: "set null" }),
    sceneId: text("scene_id"),
    atMs: integer("at_ms"),
    body: text("body").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("comments_project_idx").on(t.projectId, t.createdAt)],
);

export const reviewActionEnum = pgEnum("review_action", ["submitted", "approved", "changes_requested", "withdrawn"]);

/** Approval history (docs/PLAN.md §4.8 "Editor drafts, publisher approves. Logged."). */
export const projectReviews = pgTable(
  "project_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    timelineId: uuid("timeline_id").references(() => timelines.id, { onDelete: "set null" }),
    timelineVersion: integer("timeline_version"),
    action: reviewActionEnum("action").notNull(),
    note: text("note"),
    /** Publisher approved despite unsupported scenes in the faithfulness check (docs/PLAN.md §8). */
    faithfulnessOverride: boolean("faithfulness_override").notNull().default(false),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("project_reviews_project_idx").on(t.projectId, t.createdAt)],
);

export const renders = pgTable(
  "renders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    timelineId: uuid("timeline_id").references(() => timelines.id, { onDelete: "set null" }),
    timelineVersion: integer("timeline_version"),
    /** The channel whose logo this render carries (null = the kit's logo), and the file actually drawn, for the record. */
    logoChannelId: uuid("logo_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
    logoPath: text("logo_path"),
    remotionRenderId: text("remotion_render_id"),
    remotionBucket: text("remotion_bucket"),
    outputPath: text("output_path"),
    coverPath: text("cover_path"),
    durationSec: numeric("duration_sec", { precision: 8, scale: 2 }),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    qaJson: jsonb("qa_json").$type<Record<string, unknown>>(),
    /** Raw Remotion output before final loudness normalisation (kept under tmp/, 24 h). */
    rawPath: text("raw_path"),
    renderSeconds: numeric("render_seconds", { precision: 8, scale: 2 }),
    status: renderStatusEnum("status").notNull().default("queued"),
    error: text("error"),
    pinned: boolean("pinned").notNull().default(false),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("renders_project_idx").on(t.projectId), index("renders_status_idx").on(t.status)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    platform: platformEnum("platform").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    /** The channel's logo as drawn in its videos (R2 key under library/brand/<org>/); the platform avatar above is only for lists. */
    logoPath: text("logo_path"),
    vaultRef: uuid("vault_ref"),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    healthy: boolean("healthy").notNull().default(true),
    /** Platform-specific ids the publish step needs (Facebook page id, Instagram user id, TikTok open id / handle, public URL). */
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Admin can pause a channel without disconnecting it. */
    enabled: boolean("enabled").notNull().default(true),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("channels_org_platform_ext_uidx").on(t.organizationId, t.platform, t.externalId)],
);

export const channelGrants = pgTable(
  "channel_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("channel_grants_uidx").on(t.channelId, t.userId)],
);

export const publications = pgTable(
  "publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    renderId: uuid("render_id")
      .notNull()
      .references(() => renders.id, { onDelete: "restrict" }),
    /** Denormalised from the channel for dashboards. */
    platform: platformEnum("platform").notNull(),
    /** One key per attempt (docs/PLAN.md §4.10); a retry gets a new key. */
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(1),
    platformPostId: text("platform_post_id"),
    platformUrl: text("platform_url"),
    status: publicationStatusEnum("status").notNull().default("draft"),
    /** Title, description, hashtags, privacy as sent to the platform (+ per-platform handles while processing). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    privacy: text("privacy").notNull().default("public"),
    aiDisclosure: boolean("ai_disclosure").notNull().default(false),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    analyticsJson: jsonb("analytics_json").$type<Record<string, unknown>>(),
    analyticsAt: timestamp("analytics_at", { withTimezone: true }),
    error: text("error"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("publications_idem_uidx").on(t.idempotencyKey),
    index("publications_channel_idx").on(t.channelId),
    index("publications_scheduled_idx").on(t.status, t.scheduledAt),
    index("publications_project_idx").on(t.projectId),
    index("publications_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export const brandKits = pgTable(
  "brand_kits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    /** What the kit is for ("Thể thao: bóng đá, SEA Games…"); shown in pickers and given to the auto-matcher. */
    description: text("description").notNull().default(""),
    /** Words that select this kit when they occur in the article (fallback when the Haiku matcher is unavailable, and a hint for it). */
    matchKeywords: text("match_keywords").array().notNull().default(sql`'{}'::text[]`),
    /** False = never chosen automatically (seasonal / sponsor kits picked by hand). */
    autoMatch: boolean("auto_match").notNull().default(true),
    logoPath: text("logo_path"),
    /** How the logo moves in the video (`LOGO_MOTIONS` of @ai-news/video/schema). */
    logoMotion: text("logo_motion").$type<LogoMotion>().notNull().default("flip"),
    /** Full-frame 1080×1920 transparent PNG laid over each scene (R2 key under library/brand/<org>/). */
    overlayPath: text("overlay_path"),
    overlayLayer: text("overlay_layer").$type<"under_text" | "top">().notNull().default("under_text"),
    fonts: jsonb("fonts").$type<{ heading: string; body: string; caption: string }>().notNull(),
    colours: jsonb("colours").$type<Record<string, string>>().notNull(),
    captionStyle: jsonb("caption_style").$type<Record<string, unknown>>().notNull(),
    /** Headline card: `{ fontSize, x, y }` (x / y in frame px, null = automatic; see `textLayout`). */
    headlineStyle: jsonb("headline_style").$type<Record<string, unknown>>().notNull().default({}),
    introPath: text("intro_path"),
    outroPath: text("outro_path"),
    lowerThird: jsonb("lower_third").$type<Record<string, unknown>>(),
    safeZones: jsonb("safe_zones").$type<{ top: number; bottom: number; left: number; right: number }>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("brand_kits_org_idx").on(t.organizationId),
    uniqueIndex("brand_kits_one_default_idx").on(t.organizationId).where(sql`${t.isDefault}`),
  ],
);

export const voicePresets = pgTable(
  "voice_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null = platform default preset available to all orgs */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: languageEnum("language").notNull(),
    voice: text("voice").notNull(),
    rate: numeric("rate", { precision: 4, scale: 2 }).notNull().default("1.00"),
    pitch: numeric("pitch", { precision: 5, scale: 2 }).notNull().default("0"),
    ssmlSupported: boolean("ssml_supported").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("voice_presets_org_idx").on(t.organizationId, t.language)],
);

export const pronunciations = pgTable(
  "pronunciations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    language: languageEnum("language").notNull(),
    term: text("term").notNull(),
    replacement: text("replacement").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pronunciations_uidx").on(t.organizationId, t.language, t.term)],
);

// ---------- append-only logs ----------

export const activityEvents = pgTable(
  "activity_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    impersonatorId: text("impersonator_id"),
    organizationId: text("organization_id"),
    projectId: uuid("project_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_events_org_created_idx").on(t.organizationId, t.createdAt),
    index("activity_events_actor_idx").on(t.actorId, t.createdAt),
    index("activity_events_project_idx").on(t.projectId),
    index("activity_events_type_idx").on(t.type, t.createdAt),
  ],
);

export const usageCosts = pgTable(
  "usage_costs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    provider: text("provider").notNull(), // anthropic | google_tts | google_stt | remotion_lambda | media_lambda | pexels | mubert | ...
    resource: text("resource"), // model / voice / function name
    units: numeric("units", { precision: 14, scale: 4 }).notNull(),
    unitType: text("unit_type").notNull(), // tokens_in | tokens_out | characters | gb_seconds | render_seconds | requests
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    organizationId: text("organization_id"),
    projectId: uuid("project_id"),
    renderId: uuid("render_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_costs_created_idx").on(t.createdAt),
    index("usage_costs_org_idx").on(t.organizationId, t.createdAt),
    index("usage_costs_provider_idx").on(t.provider, t.createdAt),
  ],
);
