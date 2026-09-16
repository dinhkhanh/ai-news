import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { authorizeUrl, isOAuthProvider, NONCE_COOKIE } from "@/lib/publish/oauth";
import { signState } from "@/lib/publish/state";

/**
 * Admin starts a channel connection for a workspace: /api/channels/oauth/<youtube|meta|tiktok>/start?org=<id>.
 * The signed state binds the callback to this admin, workspace and provider; a nonce cookie stops replay.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session || session.user.role !== "admin") return NextResponse.redirect(new URL("/app?error=forbidden", req.url));
  if (!isOAuthProvider(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  const org = orgId ? await db.query.organization.findFirst({ where: eq(schema.organization.id, orgId), columns: { id: true, name: true } }) : null;
  if (!org) return NextResponse.redirect(new URL("/admin/channels?error=" + encodeURIComponent("Pick a workspace first"), req.url));

  const nonce = randomBytes(16).toString("base64url");
  const state = signState({ orgId: org.id, userId: session.user.id, provider, nonce, exp: Date.now() + 15 * 60 * 1000 }, env().BETTER_AUTH_SECRET);
  let url: string;
  try {
    url = await authorizeUrl(provider, state);
  } catch (err) {
    return NextResponse.redirect(new URL("/admin/channels?error=" + encodeURIComponent(err instanceof Error ? err.message : String(err)), req.url));
  }
  await logActivity({ actorId: session.user.id, organizationId: org.id, type: "channel.connect_started", payload: { provider } });
  const res = NextResponse.redirect(url);
  res.cookies.set(NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production", path: "/api/channels/oauth", maxAge: 15 * 60 });
  return res;
}
