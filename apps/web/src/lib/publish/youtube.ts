import "server-only";
import { getObjectStream } from "@/lib/r2";
import { composeDescription, postUrl, YOUTUBE_QUOTA, type Analytics } from "./platforms";
import { PlatformError, readJson, type PlatformClient } from "./types";

/**
 * YouTube Shorts via the Data API v3 (docs/PLAN.md §7): resumable upload
 * streamed from R2, `#Shorts` in the hashtags, synthetic-media flag from the
 * project's AI disclosure, processing polled through videos.list.
 */

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

const CATEGORY_NEWS = "25";

export const youtube: PlatformClient = {
  platform: "youtube",

  async start(job) {
    const { publication: pub, token, video, language } = job;
    const m = pub.metadata;
    const description = composeDescription("youtube", m.description, m.hashtags);
    const body = {
      snippet: {
        title: m.title.slice(0, 100),
        description,
        tags: m.hashtags.slice(0, 15),
        categoryId: CATEGORY_NEWS,
        defaultLanguage: language,
        defaultAudioLanguage: language,
      },
      status: {
        privacyStatus: pub.privacy,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: pub.aiDisclosure,
      },
    };
    const init = await fetch(UPLOAD, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(video.sizeBytes),
      },
      body: JSON.stringify(body),
    });
    if (!init.ok) await readJson(init, "YouTube upload session");
    const location = init.headers.get("location");
    if (!location) throw new PlatformError("YouTube did not return an upload URL");

    const { stream, size } = await getObjectStream(video.key);
    const up = await fetch(location, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
      body: stream,
      // Node fetch requires half-duplex for streamed request bodies.
      ...({ duplex: "half" } as Record<string, unknown>),
    });
    const created = await readJson<{ id: string; status?: { uploadStatus?: string; rejectionReason?: string } }>(up, "YouTube upload");
    if (created.status?.uploadStatus === "rejected") throw new PlatformError(`YouTube rejected the video: ${created.status.rejectionReason ?? "unknown"}`, true, created);
    return {
      state: created.status?.uploadStatus === "processed" ? "published" : "processing",
      postId: created.id,
      url: postUrl("youtube", created.id),
      handles: { videoId: created.id },
      sent: body,
      quotaUnits: YOUTUBE_QUOTA.insert,
    };
  },

  async check({ publication: pub, token }) {
    const id = pub.platformPostId ?? String(pub.metadata.handles?.videoId ?? "");
    if (!id) return { state: "failed", error: "No YouTube video id recorded" };
    const res = await readJson<{ items?: Array<{ id: string; status?: { uploadStatus?: string; rejectionReason?: string; failureReason?: string }; processingDetails?: { processingStatus?: string; processingFailureReason?: string } }> }>(
      await fetch(`${API}/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token.accessToken}` } }),
      "YouTube status",
    );
    const v = res.items?.[0];
    if (!v) return { state: "failed", error: "Video no longer exists on YouTube", quotaUnits: YOUTUBE_QUOTA.list, raw: res };
    const up = v.status?.uploadStatus;
    const proc = v.processingDetails?.processingStatus;
    if (up === "rejected") return { state: "failed", error: `Rejected: ${v.status?.rejectionReason ?? "unknown"}`, quotaUnits: YOUTUBE_QUOTA.list, raw: v };
    if (up === "failed" || proc === "failed" || proc === "terminated") return { state: "failed", error: `Processing failed: ${v.status?.failureReason ?? v.processingDetails?.processingFailureReason ?? "unknown"}`, quotaUnits: YOUTUBE_QUOTA.list, raw: v };
    if (up === "processed" || proc === "succeeded") return { state: "published", postId: id, url: postUrl("youtube", id), quotaUnits: YOUTUBE_QUOTA.list, raw: v };
    return { state: "processing", quotaUnits: YOUTUBE_QUOTA.list, raw: v };
  },

  async analytics(_channel, token, postIds) {
    const byPost: Record<string, Analytics> = {};
    let quotaUnits = 0;
    for (let i = 0; i < postIds.length; i += 50) {
      const ids = postIds.slice(i, i + 50);
      const res = await readJson<{ items?: Array<{ id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>(
        await fetch(`${API}/videos?part=statistics&id=${encodeURIComponent(ids.join(","))}`, { headers: { Authorization: `Bearer ${token.accessToken}` } }),
        "YouTube statistics",
      );
      quotaUnits += YOUTUBE_QUOTA.list;
      const pulledAt = new Date().toISOString();
      for (const it of res.items ?? []) {
        const s = it.statistics ?? {};
        byPost[it.id] = { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), shares: null, pulledAt, raw: s };
      }
    }
    return { byPost, quotaUnits };
  },
};

const num = (v: string | undefined) => (v == null ? null : Number(v));
