/**
 * Infra doctor: verifies every external dependency the app needs, using the
 * values in apps/web/.env.local. Read-only. Prints one line per check.
 *   pnpm --filter web exec tsx --env-file=.env.local scripts/check-infra.ts
 */
import { HeadBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { getFunctions } from "@remotion/lambda-client";
import postgres from "postgres";

type Check = { name: string; run: () => Promise<string> };
const env = process.env;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function check(name: string, run: () => Promise<string>) {
  try {
    results.push({ name, ok: true, detail: await run() });
  } catch (e) {
    results.push({ name, ok: false, detail: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200) });
  }
}

const checks: Check[] = [
  {
    name: "Postgres pooled (DATABASE_URL, role ai_news_app)",
    run: async () => {
      const sql = postgres(env.DATABASE_URL!, { prepare: false, max: 1, connect_timeout: 10 });
      const [r] = await sql`select current_user, (select count(*) from allowed_domains) as domains, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
      await sql.end();
      if (r.bypass) throw new Error(`connected as ${r.current_user} which has BYPASSRLS; use ai_news_app`);
      return `user=${r.current_user} bypassrls=false allowed_domains=${r.domains}`;
    },
  },
  {
    name: "Postgres direct (DATABASE_DIRECT_URL)",
    run: async () => {
      const sql = postgres(env.DATABASE_DIRECT_URL!, { prepare: false, max: 1, connect_timeout: 10 });
      const [r] = await sql`select current_user, (select count(*) from drizzle.__drizzle_migrations) as migrations`;
      await sql.end();
      return `user=${r.current_user} migrations_applied=${r.migrations}`;
    },
  },
  {
    name: "Vault read via app role",
    run: async () => {
      const sql = postgres(env.DATABASE_URL!, { prepare: false, max: 1 });
      const [r] = await sql`select count(*) as n from vault.decrypted_secrets`;
      await sql.end();
      return `secrets visible=${r.n}`;
    },
  },
  {
    name: `R2 bucket ${env.R2_BUCKET}`,
    run: async () => {
      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
        forcePathStyle: true,
      });
      await s3.send(new HeadBucketCommand({ Bucket: env.R2_BUCKET }));
      const list = await s3.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET, MaxKeys: 5 }));
      return `reachable, ${list.KeyCount ?? 0} object(s) sampled`;
    },
  },
  {
    name: "R2 lifecycle rules (Cloudflare API)",
    run: async () => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${env.R2_BUCKET}/lifecycle`, {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      });
      const json = (await res.json()) as { success: boolean; result?: { rules?: unknown[] }; errors?: Array<{ message: string }> };
      if (!json.success) throw new Error(json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`);
      const n = json.result?.rules?.length ?? 0;
      if (n === 0) throw new Error("no lifecycle rules set; run infra/r2/apply-lifecycle.sh");
      return `${n} rule(s)`;
    },
  },
  {
    name: `Remotion Lambda ${env.REMOTION_FUNCTION_NAME}`,
    run: async () => {
      const fns = await getFunctions({ region: env.AWS_REGION as "ap-southeast-1", compatibleOnly: false });
      const fn = fns.find((f) => f.functionName === env.REMOTION_FUNCTION_NAME);
      if (!fn) throw new Error(`not found; deployed: ${fns.map((f) => f.functionName).join(", ") || "none"}`);
      return `v${fn.version} mem=${fn.memorySizeInMb}MB disk=${fn.diskSizeInMb}MB timeout=${fn.timeoutInSeconds}s`;
    },
  },
  {
    name: "Remotion serve URL",
    run: async () => {
      const res = await fetch(env.REMOTION_SERVE_URL!, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    },
  },
  {
    name: `Media Lambda ${env.MEDIA_LAMBDA_FUNCTION_NAME}`,
    run: async () => {
      const lambda = new LambdaClient({
        region: env.AWS_REGION,
        credentials: { accessKeyId: env.REMOTION_AWS_ACCESS_KEY_ID!, secretAccessKey: env.REMOTION_AWS_SECRET_ACCESS_KEY! },
      });
      const fn = await lambda.send(new GetFunctionCommand({ FunctionName: env.MEDIA_LAMBDA_FUNCTION_NAME }));
      return `${fn.Configuration?.PackageType} mem=${fn.Configuration?.MemorySize}MB timeout=${fn.Configuration?.Timeout}s state=${fn.Configuration?.State}`;
    },
  },
  {
    name: "Google service account JSON",
    run: async () => {
      const sa = JSON.parse(env.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? "{}") as { client_email?: string; project_id?: string };
      if (!sa.client_email) throw new Error("missing or unparsable");
      return `${sa.client_email} project=${sa.project_id}`;
    },
  },
  {
    name: "Cloudflare Browser Rendering (phase 2 fetch)",
    run: async () => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/content`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/", gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 } }),
        signal: AbortSignal.timeout(30000),
      });
      const json = (await res.json()) as { success: boolean; result?: string; errors?: Array<{ message: string }> };
      if (!json.success) throw new Error(json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`);
      return `rendered example.com (${json.result?.length ?? 0} bytes)`;
    },
  },
  {
    name: "Anthropic API (ANTHROPIC_API_KEY or Vault integration)",
    run: async () => {
      let key = env.ANTHROPIC_API_KEY;
      if (!key) {
        const sql = postgres(env.DATABASE_URL!, { prepare: false, max: 1 });
        const [r] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'integration:anthropic' limit 1`;
        await sql.end();
        key = r?.decrypted_secret;
      }
      if (!key) throw new Error("no key in env or Vault; set it in /admin/integrations");
      // A 1-token request is the only way to surface billing problems (auth alone passes with zero credit).
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: AbortSignal.timeout(30000),
      });
      const json = (await res.json()) as { error?: { message: string }; model?: string };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      return `ok (${json.model})`;
    },
  },
  {
    name: "Inngest keys",
    run: async () => {
      if (!env.INNGEST_SIGNING_KEY?.startsWith("signkey-")) throw new Error("INNGEST_SIGNING_KEY missing/malformed");
      if (!env.INNGEST_EVENT_KEY) throw new Error("INNGEST_EVENT_KEY missing");
      return "present (sync is verified from the Inngest dashboard)";
    },
  },
];

async function main() {
  for (const c of checks) await check(c.name, c.run);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
main();
