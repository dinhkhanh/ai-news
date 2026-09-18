import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { canConnectChannel } from "@/lib/publish/channel-access";
import { authorizeUrl, isOAuthProvider, NONCE_COOKIE } from "@/lib/publish/oauth";
import { signState } from "@/lib/publish/state";
import { getWorkspace } from "@/lib/workspace";

/**
 * Starts a channel connection: /api/channels/oauth/<youtube|meta|tiktok>/start.
 * - A member links their own account to their active workspace (from /app/channels, no query).
 * - A platform admin connects for any workspace with `?org=<id>` (from /admin/channels).
 * The signed state binds the callback to this user, workspace and provider; a nonce cookie stops replay.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.redirect(new URL("/app?error=forbidden", req.url));
  if (!isOAuthProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });

  const orgParam = req.nextUrl.searchParams.get("org") ?? "";
  const from = orgParam && session.user.role === "admin" ? "admin" : "app";
  const backTo = from === "admin" ? "/admin/channels" : "/app/channels";
  const fail = (message: string) => NextResponse.redirect(new URL(`${backTo}?error=${encodeURIComponent(message)}`, req.url));

  let orgId: string;
  if (from === "admin") {
    const org = await db.query.organization.findFirst({ where: eq(schema.organization.id, orgParam), columns: { id: true } });
    if (!org) return fail("Pick a workspace first");
    orgId = org.id;
  } else {
    // Never trust an org id from the query here: a member only ever connects to the workspace they are working in.
    const ws = await getWorkspace();
    if (!ws) return NextResponse.redirect(new URL("/app?error=forbidden", req.url));
    if (!canConnectChannel(ws)) return fail("Vai trò của bạn trong workspace này không được kết nối kênh");
    orgId = ws.organizationId;
  }

  const nonce = randomBytes(16).toString("base64url");
  const state = signState({ orgId, userId: session.user.id, provider, nonce, exp: Date.now() + 15 * 60 * 1000, from }, env().BETTER_AUTH_SECRET);
  let url: string;
  try {
    url = await authorizeUrl(provider, state);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  await logActivity({ actorId: session.user.id, organizationId: orgId, type: "channel.connect_started", payload: { provider, from } });
  const res = NextResponse.redirect(url);
  res.cookies.set(NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production", path: "/api/channels/oauth", maxAge: 15 * 60 });
  return res;
}
