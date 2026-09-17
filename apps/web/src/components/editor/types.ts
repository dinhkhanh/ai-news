import type { Brand } from "@ai-news/video/schema";
import type { EditorDoc } from "@/lib/media/editor";
import type { SceneVerdict } from "@/lib/llm/schemas";
import type { FrameFaces } from "@/lib/media/framing";
import type { PendingCapture } from "@/lib/media/visual-plan";

/** A visual the editor can swap into a scene (every stock clip / article image fetched for the project). */
export type VisualOption = {
  assetId: string;
  key: string;
  kind: "video" | "image";
  durationSec: number | null;
  credit: string | null;
  thumbnailUrl: string | null;
  provider: string;
  sceneId: string | null;
  searchTerm: string | null;
  rankScore: number | null;
  /** Picture size + faces from the face guard (`assets.meta.frame`); null = never analysed. */
  frame: FrameFaces | null;
};

export type MusicOption = { id: string; title: string; key: string; moodTags: string[]; durationSec: number | null; licence: string };

export type CommentRow = { id: string; body: string; sceneId: string | null; atMs: number | null; createdAt: string; resolvedAt: string | null; authorName: string | null; authorId: string };

export type ReviewRow = { id: string; action: "submitted" | "approved" | "changes_requested" | "withdrawn"; note: string | null; timelineVersion: number | null; faithfulnessOverride: boolean; createdAt: string; actorName: string | null };

export type VersionRow = { id: string; version: number; kind: string; changes: string[]; createdAt: string; createdByName: string | null };

/** What the editor's export panel needs: logo choices, today's render quota and this project's latest renders. */
export type ExportInfo = {
  logoChannels: Array<{ id: string; name: string; platformLabel: string }>;
  defaultLogoChannelId: string | null;
  quota: { used: number; limit: number };
  renders: Array<{
    id: string;
    status: string;
    timelineId: string | null;
    version: number | null;
    createdAt: string;
    logoChannelId: string | null;
    logoName: string;
    videoUrl: string | null;
    error: string | null;
    /** Failed QA and nothing newer exists for that version: a forced render (QA not gating) may be requested. */
    canForce: boolean;
    /** Finished only because QA was overridden. */
    qaOverridden: boolean;
  }>;
};

export type EditorProps = {
  projectId: string;
  projectTitle: string;
  projectState: string;
  busyStep: string | null;
  lastError: string | null;
  userId: string;
  canEdit: boolean;
  canApprove: boolean;
  approvedTimelineId: string | null;
  sensitiveTopic: boolean;
  version: VersionRow & { note: string | null; isLatest: boolean };
  versions: VersionRow[];
  doc: EditorDoc;
  /** Mixed track stored with this version and the audio layout it was mixed for. */
  mix: { mixKey: string; signature: string } | null;
  /** R2 key → presigned URL for everything the preview may play. */
  urls: Record<string, string>;
  options: VisualOption[];
  /** YouTube picks of this build that the server could not download and nobody has recorded yet. */
  captures: PendingCapture[];
  music: MusicOption[];
  /** Logo of the project's channel (presigned), shown in the preview in place of the kit's; renders do the same swap. */
  previewLogo: { url: string; channelName: string } | null;
  /** The workspace's brand kits (R2 keys inside), so the look can be swapped without a rebuild. */
  brandKits: Array<{ id: string; name: string; isDefault: boolean; brand: Brand }>;
  verdicts: Record<string, { verdict: SceneVerdict["verdict"]; note: string | null; evidence: string | null }> | null;
  faithfulnessCounts: { supported: number; partial: number; unsupported: number; unchecked: number } | null;
  comments: CommentRow[];
  reviews: ReviewRow[];
  exportInfo: ExportInfo;
};
