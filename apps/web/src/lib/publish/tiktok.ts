import "server-only";
import { getObjectRange } from "@/lib/r2";
import { TIKTOK_API } from "./oauth";
import { chunkPlan, postUrl, type Analytics } from "./platforms";
import { PlatformError, readJson, type PlatformClient } from "./types";

/**
 * TikTok Content Posting API, Direct Post with FILE_UPLOAD (docs/PLAN.md §7):
 * creator-info query decides the privacy level (unaudited apps only get
 * SELF_ONLY), chunked PUT from R2 byte ranges, status polled by publish_id.
 */

type Envelope<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string } };

async function call<T>(path: string, token: string, body: unknown, what: string): Promise<T> {
  const res = await fetch(`${TIKTOK_API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
  const env = await readJson<Envelope<T>>(res, what);
  if (env.error && env.error.code && env.error.code !== "ok") {
    const permanent = /invalid|scope|unaudited|privacy|spam|duplicate|rate_limit_exceeded/i.test(env.error.code) && !/rate_limit/i.test(env.error.code);
    throw new PlatformError(`${what} failed: ${env.error.code} ${env.error.message ?? ""}`.trim(), permanent, env);
  }
  return (env.data ?? {}) as T;
}

export const tiktok: PlatformClient = {
  platform: "tiktok",

  async start({ publication: pub, token, video }) {
    const creator = await call<{ privacy_level_options?: string[]; max_video_post_duration_sec?: number; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean }>("/post/publish/creator_info/query/", token.accessToken, {}, "TikTok creator info");
    const allowed = creator.privacy_level_options ?? ["SELF_ONLY"];
    const privacy = allowed.includes(pub.privacy) ? pub.privacy : allowed.includes("SELF_ONLY") ? "SELF_ONLY" : allowed[0];
    if (creator.max_video_post_duration_sec && video.durationSec > creator.max_video_post_duration_sec) {
      throw new PlatformError(`TikTok allows at most ${creator.max_video_post_duration_sec}s for this account`, true, creator);
    }
    const plan = chunkPlan(video.sizeBytes);
    const postInfo = {
      title: pub.metadata.title.slice(0, 2200),
      privacy_level: privacy,
      disable_duet: Boolean(creator.duet_disabled),
      disable_comment: Boolean(creator.comment_disabled),
      disable_stitch: Boolean(creator.stitch_disabled),
      video_cover_timestamp_ms: 1000,
      is_aigc: pub.aiDisclosure,
    };
    const init = await call<{ publish_id: string; upload_url: string }>(
      "/post/publish/video/init/",
      token.accessToken,
      { post_info: postInfo, source_info: { source: "FILE_UPLOAD", video_size: video.sizeBytes, chunk_size: plan.chunkSize, total_chunk_count: plan.count } },
      "TikTok init",
    );
    for (const r of plan.ranges) {
      const bytes = await getObjectRange(video.key, r.start, r.end);
      const res = await fetch(init.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length), "Content-Range": `bytes ${r.start}-${r.end}/${video.sizeBytes}` },
        body: bytes,
      });
      if (!res.ok && res.status !== 206) throw new PlatformError(`TikTok chunk upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status === 400);
    }
    return { state: "processing", postId: null, url: null, handles: { publishId: init.publish_id }, sent: { ...postInfo, privacyRequested: pub.privacy, privacyOptions: allowed } };
  },

  async check({ publication: pub, channel, token }) {
    if (pub.platformPostId) return { state: "published", postId: pub.platformPostId, url: pub.platformUrl };
    const publishId = String(pub.metadata.handles?.publishId ?? "");
    if (!publishId) return { state: "failed", error: "No TikTok publish id recorded" };
    const st = await call<{ status?: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number>; uploaded_bytes?: number }>("/post/publish/status/fetch/", token.accessToken, { publish_id: publishId }, "TikTok status");
    if (st.status === "FAILED") return { state: "failed", error: `TikTok: ${st.fail_reason ?? "failed"}`, raw: st };
    if (st.status === "PUBLISH_COMPLETE") {
      const id = st.publicaly_available_post_id?.[0] != null ? String(st.publicaly_available_post_id[0]) : null;
      return { state: "published", postId: id ?? publishId, url: id ? postUrl("tiktok", id, channel.meta) : null, raw: st };
    }
    return { state: "processing", raw: st };
  },

  async analytics(_channel, token, postIds) {
    const byPost: Record<string, Analytics> = {};
    for (let i = 0; i < postIds.length; i += 20) {
      const ids = postIds.slice(i, i + 20);
      const res = await call<{ videos?: Array<{ id: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number; share_url?: string }> }>(
        "/video/query/?fields=id,view_count,like_count,comment_count,share_count,share_url",
        token.accessToken,
        { filters: { video_ids: ids } },
        "TikTok video query",
      );
      const pulledAt = new Date().toISOString();
      for (const v of res.videos ?? []) byPost[v.id] = { views: v.view_count ?? null, likes: v.like_count ?? null, comments: v.comment_count ?? null, shares: v.share_count ?? null, pulledAt, raw: v };
    }
    return { byPost };
  },
};
