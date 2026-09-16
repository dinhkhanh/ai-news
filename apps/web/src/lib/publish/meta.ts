import "server-only";
import { META_GRAPH, META_UPLOAD } from "./oauth";
import { composeDescription, postUrl, type Analytics } from "./platforms";
import { PlatformError, readJson, type PlatformClient } from "./types";

/**
 * Facebook Reels (Page) and Instagram Reels via the Graph API (docs/PLAN.md
 * §7). Both platforms pull the MP4 from a presigned R2 URL, so nothing is
 * proxied through Vercel. Neither has an AI-disclosure API flag; the
 * disclosure line is part of the caption (platforms.ts).
 */

const form = (params: Record<string, string>) => new URLSearchParams(params);

export const facebook: PlatformClient = {
  platform: "facebook",

  async start({ publication: pub, channel, token, video }) {
    const pageId = String(channel.meta.pageId ?? channel.externalId);
    const description = composeDescription("facebook", pub.metadata.description, pub.metadata.hashtags);
    const started = await readJson<{ video_id: string; upload_url: string }>(
      await fetch(`${META_GRAPH}/${pageId}/video_reels`, { method: "POST", body: form({ upload_phase: "start", access_token: token.accessToken }) }),
      "Facebook Reels start",
    );
    await readJson<{ success: boolean }>(
      await fetch(`${META_UPLOAD}/${started.video_id}`, { method: "POST", headers: { Authorization: `OAuth ${token.accessToken}`, file_url: video.presignedUrl } }),
      "Facebook Reels upload",
    );
    const sent = { title: pub.metadata.title.slice(0, 255), description, video_state: "PUBLISHED" };
    await readJson<{ success: boolean; post_id?: string }>(
      await fetch(`${META_GRAPH}/${pageId}/video_reels`, {
        method: "POST",
        body: form({ upload_phase: "finish", video_id: started.video_id, video_state: "PUBLISHED", title: sent.title, description, access_token: token.accessToken }),
      }),
      "Facebook Reels finish",
    );
    return { state: "processing", postId: started.video_id, url: postUrl("facebook", started.video_id), handles: { videoId: started.video_id }, sent };
  },

  async check({ publication: pub, token }) {
    const id = pub.platformPostId ?? String(pub.metadata.handles?.videoId ?? "");
    if (!id) return { state: "failed", error: "No Facebook video id recorded" };
    const res = await readJson<{ status?: { video_status?: string; processing_phase?: { status?: string; error?: { message?: string } }; publishing_phase?: { status?: string; error?: { message?: string } } }; permalink_url?: string }>(
      await fetch(`${META_GRAPH}/${id}?${form({ fields: "status,permalink_url", access_token: token.accessToken })}`),
      "Facebook Reels status",
    );
    const st = res.status?.video_status;
    const url = res.permalink_url ? `https://www.facebook.com${res.permalink_url.startsWith("/") ? res.permalink_url : `/${res.permalink_url}`}` : postUrl("facebook", id);
    if (st === "error") return { state: "failed", error: res.status?.processing_phase?.error?.message ?? res.status?.publishing_phase?.error?.message ?? "Facebook reported an error", raw: res };
    if (st === "ready" || res.status?.publishing_phase?.status === "complete") return { state: "published", postId: id, url, raw: res };
    return { state: "processing", raw: res };
  },

  async analytics(_channel, token, postIds) {
    const byPost: Record<string, Analytics> = {};
    for (const id of postIds) {
      const pulledAt = new Date().toISOString();
      try {
        const ins = await readJson<{ data?: Array<{ name: string; values?: Array<{ value: unknown }> }> }>(
          await fetch(`${META_GRAPH}/${id}/video_insights?${form({ metric: "blue_reels_play_count,post_impressions_unique,post_video_avg_time_watched,post_video_social_actions", access_token: token.accessToken })}`),
          "Facebook Reels insights",
        );
        const v = (name: string) => ins.data?.find((d) => d.name === name)?.values?.[0]?.value;
        const social = v("post_video_social_actions") as Record<string, number> | undefined;
        byPost[id] = { views: asNum(v("blue_reels_play_count")), likes: asNum(social?.LIKE), comments: asNum(social?.COMMENT), shares: asNum(social?.SHARE), pulledAt, raw: ins };
      } catch (err) {
        const basic = await readJson<{ views?: number; likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(
          await fetch(`${META_GRAPH}/${id}?${form({ fields: "views,likes.summary(true),comments.summary(true)", access_token: token.accessToken })}`),
          "Facebook video fields",
        );
        byPost[id] = { views: asNum(basic.views), likes: asNum(basic.likes?.summary?.total_count), comments: asNum(basic.comments?.summary?.total_count), shares: null, pulledAt, raw: { basic, insightsError: err instanceof Error ? err.message : String(err) } };
      }
    }
    return { byPost };
  },
};

export const instagram: PlatformClient = {
  platform: "instagram",

  async start({ publication: pub, channel, token, video }) {
    const igUserId = String(channel.meta.igUserId ?? channel.externalId);
    const caption = composeDescription("instagram", pub.metadata.description, pub.metadata.hashtags);
    const params: Record<string, string> = { media_type: "REELS", video_url: video.presignedUrl, caption, share_to_feed: "true", access_token: token.accessToken };
    if (video.coverUrl) params.cover_url = video.coverUrl;
    const container = await readJson<{ id: string }>(await fetch(`${META_GRAPH}/${igUserId}/media`, { method: "POST", body: form(params) }), "Instagram container");
    return { state: "processing", postId: null, url: null, handles: { containerId: container.id, igUserId }, sent: { caption, share_to_feed: true } };
  },

  async check({ publication: pub, channel, token }) {
    const containerId = String(pub.metadata.handles?.containerId ?? "");
    const igUserId = String(pub.metadata.handles?.igUserId ?? channel.meta.igUserId ?? channel.externalId);
    if (pub.platformPostId) return { state: "published", postId: pub.platformPostId, url: pub.platformUrl };
    if (!containerId) return { state: "failed", error: "No Instagram container id recorded" };
    const st = await readJson<{ status_code?: string; status?: string }>(await fetch(`${META_GRAPH}/${containerId}?${form({ fields: "status_code,status", access_token: token.accessToken })}`), "Instagram container status");
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") return { state: "failed", error: `Instagram container ${st.status_code}: ${st.status ?? ""}`, raw: st };
    if (st.status_code !== "FINISHED" && st.status_code !== "PUBLISHED") return { state: "processing", raw: st };
    const published = await readJson<{ id: string }>(await fetch(`${META_GRAPH}/${igUserId}/media_publish`, { method: "POST", body: form({ creation_id: containerId, access_token: token.accessToken }) }), "Instagram publish");
    let permalink: string | null = null;
    try {
      const p = await readJson<{ permalink?: string }>(await fetch(`${META_GRAPH}/${published.id}?${form({ fields: "permalink", access_token: token.accessToken })}`), "Instagram permalink");
      permalink = p.permalink ?? null;
    } catch {
      permalink = null;
    }
    return { state: "published", postId: published.id, url: permalink ?? postUrl("instagram", published.id), handles: { containerId, igUserId, mediaId: published.id }, raw: st };
  },

  async analytics(_channel, token, postIds) {
    const byPost: Record<string, Analytics> = {};
    for (const id of postIds) {
      const pulledAt = new Date().toISOString();
      let ins: { data?: Array<{ name: string; values?: Array<{ value: unknown }> }> };
      try {
        ins = await readJson(await fetch(`${META_GRAPH}/${id}/insights?${form({ metric: "views,likes,comments,shares,saved,reach", access_token: token.accessToken })}`), "Instagram insights");
      } catch {
        ins = await readJson(await fetch(`${META_GRAPH}/${id}/insights?${form({ metric: "plays,likes,comments,shares,saved,reach", access_token: token.accessToken })}`), "Instagram insights (legacy)");
      }
      const v = (name: string) => ins.data?.find((d) => d.name === name)?.values?.[0]?.value;
      byPost[id] = { views: asNum(v("views") ?? v("plays")), likes: asNum(v("likes")), comments: asNum(v("comments")), shares: asNum(v("shares")), pulledAt, raw: ins };
    }
    return { byPost };
  },
};

const asNum = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export { PlatformError };
