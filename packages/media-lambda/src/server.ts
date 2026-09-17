/**
 * Self-hosted web-video API: the media Lambda's yt-dlp actions behind a small
 * authenticated HTTP server, for a machine on a regular ISP line (e.g. the
 * office Synology NAS). YouTube bot-checks datacenter IPs (AWS, Vercel, …) but
 * not office / home connections, so downloads run here and land in the same R2
 * bucket the Lambda writes to.
 *
 *   GET  /health  → { ok, ytDlp, busy }                      (no auth)
 *   POST /invoke  → MediaResult   Authorization: Bearer <API_TOKEN>
 *                   body = a `web-video` (trim required) or `web-video-search` action
 *
 * Put it behind HTTPS (DSM reverse proxy with the DDNS certificate): the token travels in a header.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { ytdlp } from "./ffmpeg.js";
import { handler } from "./handler.js";
import { validateInvoke } from "./server-validate.js";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.API_TOKEN ?? "";
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT ?? 2));
const MAX_BODY = 64 * 1024;

if (TOKEN.length < 24) {
  console.error("API_TOKEN must be set to a random string of at least 24 characters");
  process.exit(1);
}
for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) if (!process.env[k]) console.warn(`warning: ${k} is not set, downloads cannot be stored`);

const digest = (s: string) => createHash("sha256").update(s).digest();
const tokenOk = (header: string | undefined) => {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "";
  return timingSafeEqual(digest(given), digest(TOKEN));
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

let busy = 0;
let version: string | null = null;
const ytDlpVersion = async () => (version ??= await ytdlp(["--version"]).then((r) => r.stdout.trim()).catch(() => null));
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, ytDlp: await ytDlpVersion(), busy, maxConcurrent: MAX_CONCURRENT });
      if (req.method !== "POST" || path !== "/invoke") return send(res, 404, { ok: false, error: "not found" });
      if (!tokenOk(req.headers.authorization)) {
        // Slow down guessing; never say whether a token was close.
        await new Promise((r) => setTimeout(r, 1000));
        log({ event: "unauthorized", ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress });
        return send(res, 401, { ok: false, error: "unauthorized" });
      }
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { ok: false, error: (e as Error).message === "body too large" ? "body too large" : "invalid JSON" });
      }
      const v = validateInvoke(body);
      if (!v.ok) return send(res, v.status, { ok: false, error: v.error });
      if (busy >= MAX_CONCURRENT) return send(res, 429, { ok: false, error: "busy, retry shortly" });
      busy += 1;
      const started = Date.now();
      try {
        const result = await handler(v.event);
        log({ event: v.event.action, ok: result.ok, ms: Date.now() - started, target: v.event.action === "web-video" ? v.event.input.url : v.event.input.query, error: result.error?.slice(0, 200) });
        return send(res, 200, result);
      } finally {
        busy -= 1;
      }
    } catch (e) {
      log({ event: "error", message: (e as Error).message });
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal error" });
    }
  })();
});
// Section downloads plus a CRF 18 encode can take minutes on a NAS CPU.
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.listen(PORT, () => log({ event: "listening", port: PORT, maxConcurrent: MAX_CONCURRENT }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
