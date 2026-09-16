/**
 * Pure publishing helpers (docs/PLAN.md §7): per-platform catalogue and
 * limits, metadata assembly from the script's per-platform block, source
 * attribution + AI disclosure lines (§8), idempotency keys, upload chunking.
 * No server-only imports so these are unit-tested.
 */

export const PLATFORMS = ["youtube", "facebook", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p);

export type PlatformSpec = {
  label: string;
  /** Hard limits enforced before the request is sent. */
  titleMax: number;
  descriptionMax: number;
  hashtagMax: number;
  maxDurationSec: number;
  /** Which script metadata block feeds this platform. */
  metadataKey: "youtube" | "facebook" | "tiktok";
  /** Privacy values the platform accepts (first = default). */
  privacy: readonly string[];
  /** The platform exposes a machine-readable AI-disclosure flag; otherwise we add a text line. */
  disclosureFlag: boolean;
  /** Feature flag key in /admin/integrations. */
  flag: "publish_youtube" | "publish_facebook" | "publish_instagram" | "publish_tiktok";
  /** OAuth provider that connects this platform's channels. */
  oauth: "youtube" | "meta" | "tiktok";
};

export const PLATFORM_SPEC: Record<Platform, PlatformSpec> = {
  youtube: {
    label: "YouTube Shorts",
    titleMax: 100,
    descriptionMax: 5000,
    hashtagMax: 15,
    maxDurationSec: 180,
    metadataKey: "youtube",
    privacy: ["public", "unlisted", "private"],
    disclosureFlag: true,
    flag: "publish_youtube",
    oauth: "youtube",
  },
  facebook: {
    label: "Facebook Reels",
    titleMax: 255,
    descriptionMax: 2200,
    hashtagMax: 30,
    maxDurationSec: 90,
    metadataKey: "facebook",
    privacy: ["public"],
    disclosureFlag: false,
    flag: "publish_facebook",
    oauth: "meta",
  },
  instagram: {
    label: "Instagram Reels",
    titleMax: 0,
    descriptionMax: 2200,
    hashtagMax: 30,
    maxDurationSec: 180,
    metadataKey: "facebook",
    privacy: ["public"],
    disclosureFlag: false,
    flag: "publish_instagram",
    oauth: "meta",
  },
  tiktok: {
    label: "TikTok",
    titleMax: 2200,
    descriptionMax: 0,
    hashtagMax: 30,
    maxDurationSec: 600,
    metadataKey: "tiktok",
    privacy: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
    disclosureFlag: true,
    flag: "publish_tiktok",
    oauth: "tiktok",
  },
};

export type ScriptPlatformMeta = { title: string; description: string; hashtags: string[] };

export type PublishMetadata = {
  title: string;
  description: string;
  hashtags: string[];
};

export const DISCLOSURE_LINE = { vi: "Video có sử dụng công cụ AI trong khâu dựng.", en: "This video was produced with AI tools." } as const;
export const SOURCE_LABEL = { vi: "Nguồn", en: "Source" } as const;

const tag = (h: string) => h.trim().replace(/^#+/, "").replace(/\s+/g, "");

/** Deduplicated hashtags without '#', capped; `#Shorts` is forced first on YouTube. */
export function normaliseHashtags(list: string[], platform: Platform) {
  const spec = PLATFORM_SPEC[platform];
  const out: string[] = [];
  if (platform === "youtube") out.push("Shorts");
  for (const h of list.map(tag).filter(Boolean)) {
    if (!out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h);
    if (out.length >= spec.hashtagMax) break;
  }
  return out;
}

/** Cut on a word boundary and add an ellipsis when over `max`. */
export function truncate(s: string, max: number) {
  const t = s.trim();
  if (max <= 0 || t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

export type BuildMetadataInput = {
  platform: Platform;
  meta: ScriptPlatformMeta | null | undefined;
  fallbackTitle: string;
  language: "vi" | "en";
  source: { siteName: string | null; url: string };
  aiDisclosure: boolean;
};

/**
 * Default title/description/hashtags for the publish form: script metadata
 * for the platform, then a source line (§8 attribution), an AI-disclosure line
 * on platforms without a machine flag, then the hashtags. Everything fits the
 * platform limits; the user may still edit before publishing.
 */
export function buildMetadata(input: BuildMetadataInput): PublishMetadata {
  const spec = PLATFORM_SPEC[input.platform];
  const hashtags = normaliseHashtags(input.meta?.hashtags ?? [], input.platform);
  const title = truncate(input.meta?.title || input.fallbackTitle, spec.titleMax || 2200);
  const sourceLine = `${SOURCE_LABEL[input.language]}: ${input.source.siteName ? `${input.source.siteName} · ` : ""}${input.source.url}`;
  const body = (input.meta?.description ?? "").trim();
  const lines = [body, "", sourceLine];
  if (input.aiDisclosure && !spec.disclosureFlag) lines.push(DISCLOSURE_LINE[input.language]);
  const description = lines.join("\n").trim();
  if (input.platform === "tiktok") {
    // TikTok has a single "title" field that carries caption + hashtags.
    const tags = hashtags.map((h) => `#${h}`).join(" ");
    const caption = truncate([title, body ? `\n${body}` : "", sourceLine].filter(Boolean).join("\n"), spec.titleMax - tags.length - 2);
    return { title: `${caption}\n${tags}`.trim(), description: "", hashtags };
  }
  return { title, description: truncate(description, spec.descriptionMax), hashtags };
}

/** Description as sent to the platform (hashtags appended as a final line). */
export function composeDescription(platform: Platform, description: string, hashtags: string[]) {
  const spec = PLATFORM_SPEC[platform];
  const tags = hashtags.map((h) => `#${h}`).join(" ");
  const body = description.trim();
  if (!tags) return truncate(body, spec.descriptionMax);
  const room = spec.descriptionMax - tags.length - 2;
  return `${truncate(body, room)}\n\n${tags}`.trim();
}

/** User-facing validation of the edited form values. */
export function validateMetadata(platform: Platform, m: PublishMetadata, privacy: string, durationSec: number | null) {
  const spec = PLATFORM_SPEC[platform];
  const errors: string[] = [];
  if (spec.titleMax > 0 && !m.title.trim()) errors.push("Thiếu tiêu đề");
  if (spec.titleMax > 0 && m.title.length > spec.titleMax) errors.push(`Tiêu đề quá ${spec.titleMax} ký tự`);
  if (spec.descriptionMax > 0 && m.description.length > spec.descriptionMax) errors.push(`Mô tả quá ${spec.descriptionMax} ký tự`);
  if (m.hashtags.length > spec.hashtagMax) errors.push(`Quá ${spec.hashtagMax} hashtag`);
  if (!spec.privacy.includes(privacy)) errors.push(`Chế độ hiển thị không hợp lệ cho ${spec.label}`);
  if (durationSec != null && durationSec > spec.maxDurationSec) errors.push(`${spec.label} nhận tối đa ${spec.maxDurationSec} giây (video dài ${Math.round(durationSec)} giây)`);
  return errors;
}

/** One key per attempt (docs/PLAN.md §4.10). */
export const idempotencyKey = (renderId: string, channelId: string, attempt: number) => `pub:${renderId}:${channelId}:${attempt}`;

/** YouTube Data API quota units (docs/PLAN.md §7: 1,600 per upload). */
export const YOUTUBE_QUOTA = { insert: 1600, list: 1 } as const;

/**
 * TikTok FILE_UPLOAD chunk plan: chunks between 5 MB and 64 MB, the final
 * chunk absorbs the remainder, files under the minimum go up in one chunk.
 */
export function chunkPlan(sizeBytes: number, chunkSize = 20 * 1024 * 1024) {
  const MIN = 5 * 1024 * 1024;
  if (sizeBytes <= 0) throw new Error("empty file");
  if (sizeBytes < MIN || sizeBytes <= chunkSize) return { chunkSize: sizeBytes, count: 1, ranges: [{ start: 0, end: sizeBytes - 1 }] };
  const count = Math.floor(sizeBytes / chunkSize);
  const ranges = Array.from({ length: count }, (_, i) => ({ start: i * chunkSize, end: i === count - 1 ? sizeBytes - 1 : (i + 1) * chunkSize - 1 }));
  return { chunkSize, count, ranges };
}

/** Public URL of a published post. */
export function postUrl(platform: Platform, postId: string, channelMeta: Record<string, unknown> = {}) {
  switch (platform) {
    case "youtube":
      return `https://www.youtube.com/shorts/${postId}`;
    case "facebook":
      return `https://www.facebook.com/reel/${postId}`;
    case "instagram":
      return typeof channelMeta.permalink === "string" ? channelMeta.permalink : `https://www.instagram.com/reel/${postId}/`;
    case "tiktok": {
      const handle = typeof channelMeta.handle === "string" ? channelMeta.handle : null;
      return handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : `https://www.tiktok.com/video/${postId}`;
    }
  }
}

/** Normalised analytics shape stored in publications.analytics_json. */
export type Analytics = { views: number | null; likes: number | null; comments: number | null; shares: number | null; pulledAt: string; raw: unknown };

/** Interpret a Vietnamese wall-clock datetime-local value (no zone) as Asia/Ho_Chi_Minh (UTC+7). */
export function parseVietnamLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatVietnam(d: Date) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }).format(d);
}
