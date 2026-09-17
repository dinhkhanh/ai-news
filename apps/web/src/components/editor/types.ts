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
  verdicts: Record<string, { verdict: SceneVerdict["verdict"]; note: string | null; evidence: string | null }> | null;
  faithfulnessCounts: { supported: number; partial: number; unsupported: number; unchecked: number } | null;
  comments: CommentRow[];
  reviews: ReviewRow[];
};
