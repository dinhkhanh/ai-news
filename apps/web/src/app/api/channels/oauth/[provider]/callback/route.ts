import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { roleCanConnectChannel } from "@/lib/publish/channel-access";
import { grantChannelAccess } from "@/lib/publish/channel-ops";
import { exchangeCode, isOAuthProvider, NONCE_COOKIE, storeChannelToken } from "@/lib/publish/oauth";
import { verifyState, type OAuthState } from "@/lib/publish/state";
import { memberRole } from "@/lib/workspace";

/** Back to the page the flow started on: a member's /app/channels, or the admin page (also for states signed before `from` existed). */
const back = (req: NextRequest, from: OAuthState["from"], q: Record<string, string>) => {
  const u = new URL(from === "app" ? "/app/channels" : "/admin/channels", req.url);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const res = NextResponse.redirect(u);
  res.cookies.delete(NONCE_COOKIE);
  return res;
};

/**
 * OAuth callback: verifies the signed state + nonce cookie + the session of the
 * user who started it (still a writer of that workspace, or a platform admin),
 * exchanges the code, stores every discovered account as a `channels` row with
 * its token in Vault (upsert on org + platform + external id) and grants the
 * channel to the member who connected it, so they can publish right away.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.redirect(new URL("/app?error=forbidden", req.url));
  const isAdmin = session.user.role === "admin";
  const state = verifyState(q.get("state") ?? "", env().BETTER_AUTH_SECRET);
  const nonce = req.cookies.get(NONCE_COOKIE)?.value;
  // Only a platform admin is ever sent back to the admin page.
  const from: OAuthState["from"] = isAdmin ? (state?.from ?? "admin") : "app";
  if (!state || state.provider !== provider || state.userId !== session.user.id || !nonce || nonce !== state.nonce) return back(req, from, { error: "Connection state is invalid or expired; start again" });
  // The membership is checked again here: the role may have changed in the 15 minutes the state lives.
  const role = await memberRole(session.user.id, state.orgId);
  if (!isAdmin && !roleCanConnectChannel(role)) return back(req, from, { error: "Vai trò của bạn trong workspace này không được kết nối kênh" });
  const oauthError = q.get("error_description") ?? q.get("error");
  if (oauthError) {
    await logActivity({ actorId: session.user.id, organizationId: state.orgId, type: "channel.connect_failed", payload: { provider, error: oauthError } });
    return back(req, from, { error: `${provider}: ${oauthError}` });
  }
  const code = q.get("code");
  if (!code) return back(req, from, { error: "Missing authorisation code" });

  try {
    const found = await exchangeCode(provider, code);
    const names: string[] = [];
    for (const c of found) {
      const id = await withServiceContext(async (tx) => {
        const existing = await tx.query.channels.findFirst({ where: and(eq(schema.channels.organizationId, state.orgId), eq(schema.channels.platform, c.platform), eq(schema.channels.externalId, c.externalId)) });
        // Reconnecting a live channel (a colleague, or an admin fixing a token) does not take it over from whoever connected it.
        const connectedBy = existing?.connectedBy && existing.vaultRef ? existing.connectedBy : session.user.id;
        const base = { name: c.name, avatarUrl: c.avatarUrl, scopes: c.scopes, expiresAt: c.token.expiresAt ? new Date(c.token.expiresAt) : null, lastRefreshAt: new Date(), healthy: true, lastError: null, lastCheckedAt: new Date(), meta: { ...(existing?.meta ?? {}), ...c.meta }, connectedBy };
        if (existing) {
          // Disconnecting a channel with history pauses it; connecting it again undoes that (a pause on a live channel stays).
          await tx.update(schema.channels).set(existing.vaultRef ? base : { ...base, enabled: true }).where(eq(schema.channels.id, existing.id));
          return existing.id;
        }
        const [row] = await tx.insert(schema.channels).values({ organizationId: state.orgId, platform: c.platform, externalId: c.externalId, ...base }).returning({ id: schema.channels.id });
        return row.id;
      });
      const vaultRef = await storeChannelToken(id, c.token);
      await withServiceContext((tx) => tx.update(schema.channels).set({ vaultRef }).where(eq(schema.channels.id, id)));
      // Members get their own channel straight away (no-op for an admin who is not a member of that workspace).
      if (role) await grantChannelAccess({ id, organizationId: state.orgId }, session.user.id, session.user.id);
      names.push(`${c.platform}: ${c.name}`);
      await logActivity({ actorId: session.user.id, organizationId: state.orgId, type: "channel.connected", payload: { channelId: id, platform: c.platform, externalId: c.externalId, name: c.name, scopes: c.scopes } });
    }
    return back(req, from, { connected: names.join(", ") });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logActivity({ actorId: session.user.id, organizationId: state.orgId, type: "channel.connect_failed", payload: { provider, error: message.slice(0, 500) } });
    return back(req, from, { error: message });
  }
}
