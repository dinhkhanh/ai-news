import type { OpenAiImageUsage } from "./models";

/**
 * GPT Image on the OpenAI Images API (docs/COMIC.md §5), raw `fetch`, no SDK: `/v1/images/edits` (multipart, the
 * references as `image[]`) when there are reference images, `/v1/images/generations` otherwise. The key is passed in
 * (the `openai` integration secret, read by the caller), so this file has no server imports and its error mapping is
 * unit-tested.
 */

const API = "https://api.openai.com/v1/images";
/** One attempt may take this long; a retry only starts within `RETRY_WINDOW_MS` of the first, so a step stays < 300 s. */
const ATTEMPT_MS = 150_000;
const RETRY_WINDOW_MS = 60_000;
const BILLING_CODES = new Set(["credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "insufficient_quota", "billing_hard_limit_reached"]);

export type OpenAiImageRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  refs: { bytes: Buffer; mime: string }[];
  size: string;
  quality: "low" | "medium" | "high";
};

export class OpenAiImageError extends Error {
  constructor(
    message: string,
    /** A retry cannot fix it: moderation, billing, key or permission, bad request. */
    readonly permanent: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenAiImageError";
  }
}

type ErrorBody = { error?: { message?: string; type?: string; code?: string | null } };

/** What an error response means for the comic studio: the message shown on the panel and whether to try again. */
export function classifyOpenAiError(status: number, body: string): { permanent: boolean; message: string } {
  let err: ErrorBody["error"] = {};
  try {
    err = (JSON.parse(body) as ErrorBody).error ?? {};
  } catch {
    // Not JSON (a proxy page): keep the status.
  }
  const code = err.code ?? "";
  const detail = (err.message ?? body).slice(0, 200);
  if (code === "moderation_blocked" || err.type === "image_generation_user_error")
    return { permanent: true, message: `OpenAI từ chối nội dung khung này (${code || err.type}): sửa mô tả rồi vẽ lại` };
  if (BILLING_CODES.has(code) || err.type === "insufficient_quota") return { permanent: true, message: `OpenAI: hết hạn mức hoặc chạm giới hạn chi (${code || err.type})` };
  if (status === 401) return { permanent: true, message: "OpenAI: API key không hợp lệ (sửa ở /admin/integrations)" };
  if (status === 403) return { permanent: true, message: `OpenAI: không có quyền dùng mô hình này (tổ chức cần xác minh?): ${detail}` };
  if (status === 429 || status >= 500) return { permanent: false, message: `OpenAI HTTP ${status}: ${detail}` };
  return { permanent: true, message: `OpenAI HTTP ${status}: ${detail}` };
}

const extOf = (mime: string) => (mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png");

function body(req: OpenAiImageRequest): { url: string; init: RequestInit } {
  const headers = { Authorization: `Bearer ${req.apiKey}` };
  // `input_fidelity` is left out: GPT Image 2 always keeps reference images at high fidelity and rejects it.
  if (!req.refs.length)
    return {
      url: `${API}/generations`,
      init: { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ model: req.model, prompt: req.prompt, size: req.size, quality: req.quality, output_format: "png", n: 1 }) },
    };
  const form = new FormData();
  form.append("model", req.model);
  form.append("prompt", req.prompt);
  form.append("size", req.size);
  form.append("quality", req.quality);
  form.append("output_format", "png");
  form.append("n", "1");
  req.refs.forEach((r, i) => form.append("image[]", new Blob([new Uint8Array(r.bytes)], { type: r.mime }), `ref-${i + 1}.${extOf(r.mime)}`));
  return { url: `${API}/edits`, init: { method: "POST", headers, body: form } };
}

/** One picture; rate limits, server and network errors are tried again (twice at most) while they come back fast. */
export async function openaiGenerateImage(req: OpenAiImageRequest): Promise<{ bytes: Buffer; mime: string; usage: OpenAiImageUsage | null }> {
  const started = Date.now();
  let last: OpenAiImageError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(20_000, 2_000 * 3 ** (attempt - 1));
      if (Date.now() - started + wait > RETRY_WINDOW_MS) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    const { url, init } = body(req);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_MS) });
    } catch (e) {
      last = new OpenAiImageError(`OpenAI: ${(e as Error).message}`, false, 0);
      continue;
    }
    if (!res.ok) {
      const c = classifyOpenAiError(res.status, await res.text());
      last = new OpenAiImageError(c.message, c.permanent, res.status);
      if (c.permanent) throw last;
      continue;
    }
    const json = (await res.json()) as { data?: { b64_json?: string }[]; output_format?: string; usage?: OpenAiImageUsage };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new OpenAiImageError("OpenAI không trả về ảnh", false, res.status);
    const format = json.output_format ?? "png";
    return { bytes: Buffer.from(b64, "base64"), mime: format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png", usage: json.usage ?? null };
  }
  throw last ?? new OpenAiImageError("OpenAI: không vẽ được", false, 0);
}
