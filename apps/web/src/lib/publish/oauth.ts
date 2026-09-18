import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { env } from "@/lib/env";
import { deleteSecret, readSecret, upsertSecret } from "@/lib/vault";
import type { Platform } from "./platforms";

/**
 * Channel OAuth (docs/PLAN.md §7 "tokens in Vault, cron refresh, admin alert
 * on failure"). Google uses the Internal OAuth client from env; Meta and
 * TikTok app credentials come from /admin/integrations (Vault).
 */

export type OAuthProvider = "youtube" | "meta" | "tiktok";
export const isOAuthProvider = (p: string): p is OAuthProvider => p === "youtube" || p === "meta" || p === "tiktok";

export type ChannelToken = {
  accessToken: string;
  refreshToken?: string | null;
  /** ISO time the access token expires; null for non-expiring page tokens. */
  expiresAt?: string | null;
  tokenType?: string;
  scope?: string;
};

export const META_GRAPH = "https://graph.facebook.com/v22.0";
export const META_UPLOAD = "https://rupload.facebook.com/video-upload/v22.0";
export const TIKTOK_API = "https://open.tiktokapis.com/v2";

export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
export const META_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "publish_video", "instagram_basic", "instagram_content_publish", "business_management"];
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"];

export const NONCE_COOKIE = "ai_news_chan_oauth";

export const redirectUri = (provider: OAuthProvider) => `${env().APP_URL}/api/channels/oauth/${provider}/callback`;

/** `APP_ID:APP_SECRET` (Meta) / `CLIENT_KEY:CLIENT_SECRET` (TikTok) from the integrations table. */
export async function appCredentials(provider: "meta" | "tiktok") {
  const key = provider === "meta" ? "meta_app" : "tiktok_app";
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, key) });
  if (!row?.enabled || !row.vaultRef) throw new Error(`${provider === "meta" ? "Meta" : "TikTok"} app credentials are not set or disabled in /admin/integrations`);
  const secret = await readSecret(row.vaultRef);
  const idx = secret?.indexOf(":") ?? -1;
  if (!secret || idx <= 0) throw new Error(`${key} secret must be ID:SECRET`);
  return { id: secret.slice(0, idx).trim(), secret: secret.slice(idx + 1).trim() };
}

export async function authorizeUrl(provider: OAuthProvider, state: string) {
  const e = env();
  switch (provider) {
    case "youtube": {
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", e.GOOGLE_CLIENT_ID);
      u.searchParams.set("redirect_uri", redirectUri(provider));
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("include_granted_scopes", "false");
      u.searchParams.set("state", state);
      return u.toString();
    }
    case "meta": {
      const { id } = await appCredentials("meta");
      const u = new URL("https://www.facebook.com/v22.0/dialog/oauth");
      u.searchParams.set("client_id", id);
      u.searchParams.set("redirect_uri", redirectUri(provider));
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", META_SCOPES.join(","));
      u.searchParams.set("state", state);
      return u.toString();
    }
    case "tiktok": {
      const { id } = await appCredentials("tiktok");
      const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
      u.searchParams.set("client_key", id);
      u.searchParams.set("redirect_uri", redirectUri(provider));
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", TIKTOK_SCOPES.join(","));
      u.searchParams.set("state", state);
      return u.toString();
    }
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const b = body as { error?: { message?: string; code?: unknown } | string; error_description?: string; message?: string };
    const msg = typeof b.error === "string" ? `${b.error}: ${b.error_description ?? ""}` : (b.error?.message ?? b.message ?? text.slice(0, 300));
    throw new Error(`${what} failed (${res.status}): ${msg}`);
  }
  return body as T;
}

const expiresAtFrom = (expiresIn: number | undefined | null) => (expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null);

/** A connected account discovered after the code exchange; each becomes a `channels` row. */
export type DiscoveredChannel = {
  platform: Platform;
  externalId: string;
  name: string;
  avatarUrl: string | null;
  scopes: string[];
  token: ChannelToken;
  meta: Record<string, unknown>;
};

export async function exchangeCode(provider: OAuthProvider, code: string): Promise<DiscoveredChannel[]> {
  const e = env();
  switch (provider) {
    case "youtube": {
      const tok = await json<{ access_token: string; refresh_token?: string; expires_in: number; scope: string; token_type: string }>(
        await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code, client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(provider), grant_type: "authorization_code" }),
        }),
        "Google token exchange",
      );
      if (!tok.refresh_token) throw new Error("Google did not return a refresh token; remove the app from the account's third-party access and connect again");
      const ch = await json<{ items?: Array<{ id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } } }> }>(
        await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${tok.access_token}` } }),
        "YouTube channel lookup",
      );
      const item = ch.items?.[0];
      if (!item) throw new Error("This Google account has no YouTube channel");
      return [
        {
          platform: "youtube",
          externalId: item.id,
          name: item.snippet.title,
          avatarUrl: item.snippet.thumbnails?.default?.url ?? null,
          scopes: tok.scope.split(" "),
          token: { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: expiresAtFrom(tok.expires_in), tokenType: tok.token_type, scope: tok.scope },
          meta: { customUrl: item.snippet.customUrl ?? null },
        },
      ];
    }
    case "meta": {
      const app = await appCredentials("meta");
      const short = await json<{ access_token: string }>(
        await fetch(`${META_GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: app.id, client_secret: app.secret, redirect_uri: redirectUri(provider), code })}`),
        "Meta token exchange",
      );
      const long = await json<{ access_token: string; expires_in?: number }>(
        await fetch(`${META_GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app.id, client_secret: app.secret, fb_exchange_token: short.access_token })}`),
        "Meta long-lived token",
      );
      const perms = await json<{ data?: Array<{ permission: string; status: string }> }>(await fetch(`${META_GRAPH}/me/permissions?access_token=${encodeURIComponent(long.access_token)}`), "Meta permissions");
      const granted = (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
      const pages = await json<{ data?: Array<{ id: string; name: string; access_token: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username?: string; profile_picture_url?: string } }> }>(
        await fetch(`${META_GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}", limit: "100", access_token: long.access_token })}`),
        "Meta pages lookup",
      );
      const out: DiscoveredChannel[] = [];
      for (const p of pages.data ?? []) {
        // Page tokens derived from a long-lived user token do not expire.
        const token: ChannelToken = { accessToken: p.access_token, expiresAt: null, tokenType: "page" };
        out.push({ platform: "facebook", externalId: p.id, name: p.name, avatarUrl: p.picture?.data?.url ?? null, scopes: granted, token, meta: { pageId: p.id } });
        if (p.instagram_business_account) {
          const ig = p.instagram_business_account;
          out.push({ platform: "instagram", externalId: ig.id, name: ig.username ? `@${ig.username}` : `Instagram ${ig.id}`, avatarUrl: ig.profile_picture_url ?? null, scopes: granted, token, meta: { pageId: p.id, igUserId: ig.id, username: ig.username ?? null } });
        }
      }
      if (out.length === 0) throw new Error("No Facebook Pages are managed by this account (or pages_show_list was not granted)");
      return out;
    }
    case "tiktok": {
      const app = await appCredentials("tiktok");
      const tok = await json<{ access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number; open_id: string; scope: string; token_type: string; error?: string; error_description?: string }>(
        await fetch(`${TIKTOK_API}/oauth/token/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_key: app.id, client_secret: app.secret, code, grant_type: "authorization_code", redirect_uri: redirectUri(provider) }),
        }),
        "TikTok token exchange",
      );
      if (tok.error) throw new Error(`TikTok token exchange failed: ${tok.error} ${tok.error_description ?? ""}`);
      const info = await json<{ data?: { user?: { open_id: string; display_name?: string; avatar_url?: string; username?: string } } }>(
        await fetch(`${TIKTOK_API}/user/info/?fields=open_id,display_name,avatar_url,username`, { headers: { Authorization: `Bearer ${tok.access_token}` } }),
        "TikTok user info",
      );
      const u = info.data?.user;
      return [
        {
          platform: "tiktok",
          externalId: tok.open_id,
          name: u?.display_name ?? `TikTok ${tok.open_id.slice(0, 8)}`,
          avatarUrl: u?.avatar_url ?? null,
          scopes: tok.scope.split(","),
          token: { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: expiresAtFrom(tok.expires_in), tokenType: tok.token_type, scope: tok.scope },
          meta: { openId: tok.open_id, handle: u?.username ?? null, refreshExpiresAt: expiresAtFrom(tok.refresh_expires_in) },
        },
      ];
    }
  }
}

// ---------- token storage (Vault) ----------

export const tokenSecretName = (channelId: string) => `channel:${channelId}`;

export async function storeChannelToken(channelId: string, token: ChannelToken) {
  return upsertSecret(tokenSecretName(channelId), JSON.stringify(token), `OAuth token for channel ${channelId}`);
}

export async function loadChannelToken(channel: { id: string; vaultRef: string | null }): Promise<ChannelToken> {
  if (!channel.vaultRef) throw new Error("Channel has no stored token; reconnect it in /app/channels");
  const raw = await readSecret(channel.vaultRef);
  if (!raw) throw new Error("Channel token missing from Vault; reconnect it in /app/channels");
  return JSON.parse(raw) as ChannelToken;
}

export async function deleteChannelToken(channel: { vaultRef: string | null }) {
  if (channel.vaultRef) await deleteSecret(channel.vaultRef).catch(() => undefined);
}

// ---------- refresh ----------

export async function refreshToken(platform: Platform, token: ChannelToken): Promise<ChannelToken> {
  const e = env();
  if (platform === "youtube") {
    if (!token.refreshToken) throw new Error("No refresh token");
    const tok = await json<{ access_token: string; expires_in: number; scope?: string; token_type: string }>(
      await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ refresh_token: token.refreshToken, client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token" }),
      }),
      "Google token refresh",
    );
    return { ...token, accessToken: tok.access_token, expiresAt: expiresAtFrom(tok.expires_in), scope: tok.scope ?? token.scope };
  }
  if (platform === "tiktok") {
    if (!token.refreshToken) throw new Error("No refresh token");
    const app = await appCredentials("tiktok");
    const tok = await json<{ access_token: string; refresh_token: string; expires_in: number; error?: string; error_description?: string }>(
      await fetch(`${TIKTOK_API}/oauth/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_key: app.id, client_secret: app.secret, grant_type: "refresh_token", refresh_token: token.refreshToken }),
      }),
      "TikTok token refresh",
    );
    if (tok.error) throw new Error(`TikTok token refresh failed: ${tok.error} ${tok.error_description ?? ""}`);
    return { ...token, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: expiresAtFrom(tok.expires_in) };
  }
  // Meta page tokens do not expire; nothing to refresh.
  return token;
}

/** Lightweight validity probe used by the health cron and the admin "check" button. */
export async function probeToken(platform: Platform, token: ChannelToken, meta: Record<string, unknown>) {
  switch (platform) {
    case "youtube":
      await json(await fetch("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", { headers: { Authorization: `Bearer ${token.accessToken}` } }), "YouTube probe");
      return;
    case "facebook":
    case "instagram": {
      const id = platform === "instagram" ? String(meta.igUserId ?? "me") : String(meta.pageId ?? "me");
      await json(await fetch(`${META_GRAPH}/${id}?fields=id&access_token=${encodeURIComponent(token.accessToken)}`), "Meta probe");
      return;
    }
    case "tiktok":
      await json(await fetch(`${TIKTOK_API}/user/info/?fields=open_id`, { headers: { Authorization: `Bearer ${token.accessToken}` } }), "TikTok probe");
      return;
  }
}

export type ChannelRow = typeof schema.channels.$inferSelect;

/**
 * Access token for a channel, refreshed (and re-stored) when it expires within
 * `skewMs`. Marks the channel unhealthy when the refresh fails.
 */
export async function channelAccessToken(channel: ChannelRow, skewMs = 5 * 60 * 1000): Promise<ChannelToken> {
  let token = await loadChannelToken(channel);
  const exp = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
  if (exp != null && exp - Date.now() < skewMs) {
    try {
      token = await refreshToken(channel.platform, token);
      await storeChannelToken(channel.id, token);
      await withServiceContext((tx) => tx.update(schema.channels).set({ expiresAt: token.expiresAt ? new Date(token.expiresAt) : null, lastRefreshAt: new Date(), healthy: true, lastError: null }).where(eq(schema.channels.id, channel.id)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: false, lastError: message.slice(0, 1000), lastCheckedAt: new Date() }).where(eq(schema.channels.id, channel.id)));
      throw new Error(`Channel token refresh failed: ${message}`);
    }
  }
  return token;
}
