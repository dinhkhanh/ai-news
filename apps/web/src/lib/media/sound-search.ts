import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { readSecret } from "@/lib/vault";
import {
  audioContentType,
  isAllowedAudioUrl,
  keepResult,
  OPENVERSE_MAX_RESULTS,
  openverseDetailUrl,
  openverseSearchUrl,
  parseOpenverseAudio,
  SOUND_MAX_BYTES,
  type SoundResult,
  type SoundSearch,
} from "./sound-library";

/**
 * Openverse (api.openverse.org) for the sound library. Works without a key at Openverse's anonymous limits;
 * with the `openverse` integration (`CLIENT_ID:CLIENT_SECRET` from /v1/auth_tokens/register/) requests carry a
 * client-credentials token and get the higher registered limits. Openverse asks API users to identify themselves.
 */
const BASE = "https://api.openverse.org";
const UA = "ai-news/1.0 (newsroom video tool; sound library)";

let token: { value: string; expiresAt: number; secret: string } | null = null;

async function openverseCredentials() {
  const row = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, "openverse") });
  if (!row?.enabled || !row.vaultRef) return null;
  return readSecret(row.vaultRef);
}

async function bearer(): Promise<string | null> {
  const secret = await openverseCredentials().catch(() => null);
  if (!secret) return null;
  if (token && token.secret === secret && token.expiresAt > Date.now() + 60_000) return token.value;
  const [clientId, clientSecret] = secret.split(":");
  if (!clientId || !clientSecret) return null;
  const res = await fetch(`${BASE}/v1/auth_tokens/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null; // fall back to anonymous rather than failing the search
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!json?.access_token) return null;
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000, secret };
  return token.value;
}

async function openverseGet(url: string): Promise<unknown> {
  const auth = await bearer();
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, signal: AbortSignal.timeout(15_000) }).catch((e: unknown) => {
    throw new Error(`Openverse không phản hồi (${e instanceof Error ? e.message : "lỗi mạng"})`);
  });
  if (res.status === 429) throw new Error("Openverse đang giới hạn lượt tìm. Thử lại sau ít phút, hoặc nhờ admin thêm khoá Openverse ở mục Tích hợp.");
  if (res.status === 404) throw new Error("Openverse không còn âm thanh này");
  if (!res.ok) throw new Error(`Openverse trả lỗi HTTP ${res.status}`);
  return res.json();
}

export type SoundSearchPage = { results: SoundResult[]; total: number; page: number; pageCount: number; hidden: number };

export async function searchOpenverse(f: SoundSearch): Promise<SoundSearchPage> {
  const json = (await openverseGet(openverseSearchUrl(f, BASE))) as { result_count?: number; page_count?: number; results?: unknown[] };
  const parsed = (json.results ?? []).map(parseOpenverseAudio).filter((r): r is SoundResult => r !== null);
  const results = parsed.filter((r) => keepResult(r, f.commercialOnly));
  return {
    results,
    total: Math.min(json.result_count ?? results.length, OPENVERSE_MAX_RESULTS),
    page: f.page,
    pageCount: json.page_count ?? 1,
    hidden: parsed.length - results.length,
  };
}

/** Re-read one result from Openverse by id: what gets stored never comes from the browser. */
export async function openverseAudio(id: string): Promise<SoundResult> {
  const url = openverseDetailUrl(id, BASE);
  if (!url) throw new Error("Mã âm thanh không hợp lệ");
  const r = parseOpenverseAudio(await openverseGet(url));
  if (!r) throw new Error("Âm thanh này không có tệp nghe được");
  return r;
}

/**
 * Download an Openverse audio file (allow-listed hosts only, every redirect hop re-checked, at most
 * `SOUND_MAX_BYTES`). Returns the bytes and the MIME type to store them with.
 */
export async function downloadSound(url: string): Promise<{ body: Buffer; contentType: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedAudioUrl(current)) throw new Error("Nguồn tệp âm thanh không được phép");
    const res = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new Error("Nguồn trả chuyển hướng không có địa chỉ");
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`Không tải được tệp âm thanh (HTTP ${res.status})`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > SOUND_MAX_BYTES) throw new Error("Tệp âm thanh lớn hơn 25 MB");
    const contentType = audioContentType(new URL(current).pathname, res.headers.get("content-type")) ?? (/format=mp3/.test(current) ? "audio/mpeg" : null);
    if (!contentType) throw new Error(`Nguồn trả tệp không phải âm thanh (${res.headers.get("content-type") ?? "không rõ"})`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SOUND_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Tệp âm thanh lớn hơn 25 MB");
      }
      chunks.push(value);
    }
    if (size === 0) throw new Error("Tệp âm thanh rỗng");
    return { body: Buffer.concat(chunks), contentType };
  }
  throw new Error("Nguồn chuyển hướng quá nhiều lần");
}
