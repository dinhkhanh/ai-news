/** Signed OAuth `state` for channel connections: binds the callback to the admin, workspace and platform that started it. Pure (node:crypto only). */
import { createHmac, timingSafeEqual } from "node:crypto";

export type OAuthState = { orgId: string; userId: string; provider: "youtube" | "meta" | "tiktok"; nonce: string; exp: number };

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function signState(state: OAuthState, secret: string) {
  const payload = b64(JSON.stringify(state));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(token: string, secret: string, now = Date.now()): OAuthState | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (!s.orgId || !s.userId || !s.provider || !s.nonce || typeof s.exp !== "number") return null;
    if (s.exp < now) return null;
    return s;
  } catch {
    return null;
  }
}
