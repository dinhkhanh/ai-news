import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { exchangeCode, isOAuthProvider, NONCE_COOKIE, storeChannelToken } from "@/lib/publish/oauth";
import { verifyState } from "@/lib/publish/state";

const back = (req: NextRequest, q: Record<string, string>) => {
  const u = new URL("/admin/channels", req.url);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const res = NextResponse.redirect(u);
  res.cookies.delete(NONCE_COOKIE);
  return res;
};

/**
 * OAuth callback: verifies the signed state + nonce cookie + admin session,
 * exchanges the code, stores every discovered account as a `channels` row
 * with its token in Vault (upsert on org + platform + external id).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isOAuthProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session || session.user.role !== "admin") return NextResponse.redirect(new URL("/app?error=forbidden", req.url));
  const state = verifyState(q.get("state") ?? "", env().BETTER_AUTH_SECRET);
  const nonce = req.cookies.get(NONCE_COOKIE)?.value;
  if (!state || state.provider !== provider || state.userId !== session.user.id || !nonce || nonce !== state.nonce) return back(req, { error: "Connection state is invalid or expired; start again" });
  const oauthError = q.get("error_description") ?? q.get("error");
  if (oauthError) {
    await logActivity({ actorId: session.user.id, organizationId: state.orgId, type: "channel.connect_failed", payload: { provider, error: oauthError } });
    return back(req, { error: `${provider}: ${oauthError}` });
  }
  const code = q.get("code");
  if (!code) return back(req, { error: "Missing authorisation code" });

  try {
    const found = await exchangeCode(provider, code);
    const names: string[] = [];
    for (const c of found) {
      const id = await withServiceContext(async (tx) => {
        const existing = await tx.query.channels.findFirst({ where: and(eq(schema.channels.organizationId, state.orgId), eq(schema.channels.platform, c.platform), eq(schema.channels.externalId, c.externalId)) });
        const base = { name: c.name, avatarUrl: c.avatarUrl, scopes: c.scopes, expiresAt: c.token.expiresAt ? new Date(c.token.expiresAt) : null, lastRefreshAt: new Date(), healthy: true, lastError: null, lastCheckedAt: new Date(), meta: { ...(existing?.meta ?? {}), ...c.meta }, connectedBy: session.user.id };
        if (existing) {
          await tx.update(schema.channels).set(base).where(eq(schema.channels.id, existing.id));
          return existing.id;
        }
        const [row] = await tx.insert(schema.channels).values({ organizationId: state.orgId, platform: c.platform, externalId: c.externalId, ...base }).returning({ id: schema.channels.id });
        return row.id;
      });
      const vaultRef = await storeChannelToken(id, c.token);
      await withServiceContext((tx) => tx.update(schema.channels).set({ vaultRef }).where(eq(schema.channels.id, id)));
      names.push(`${c.platform}: ${c.name}`);
      await logActivity({ actorId: session.user.id, organizationId: state.orgId, type: "channel.connected", payload: { channelId: id, platform: c.platform, externalId: c.externalId, name: c.name, scopes: c.scopes } });
    }
    return back(req, { connected: names.join(", ") });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logActivity({ actorId: session.user.id, organizationId: state.orgId, type: "channel.connect_failed", payload: { provider, error: message.slice(0, 500) } });
    return back(req, { error: message });
  }
}
