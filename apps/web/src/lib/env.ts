import { z } from "zod";

/**
 * Server env. Validated lazily so `next build` and CLI scripts don't need
 * every runtime secret; each accessor throws a readable error when used.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().optional(),

  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  /** Comma-separated bootstrap list; also seeded into allowed_domains on first migration. */
  ALLOWED_DOMAINS: z.string().default("suzu.group"),
  /** Comma-separated emails that get platform_role=admin on first sign-in. */
  ADMIN_EMAILS: z.string().default(""),

  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("ai-news"),
  R2_PUBLIC_BASE_URL: z.string().optional(),

  AWS_REGION: z.string().default("ap-southeast-1"),
  REMOTION_AWS_ACCESS_KEY_ID: z.string().optional(),
  REMOTION_AWS_SECRET_ACCESS_KEY: z.string().optional(),
  REMOTION_FUNCTION_NAME: z.string().optional(),
  REMOTION_SERVE_URL: z.string().optional(),
  MEDIA_LAMBDA_FUNCTION_NAME: z.string().default("ai-news-media"),
  /** Self-hosted web-video API on a regular ISP line (office NAS): base URL (https) + bearer token. Unset = downloads run on the Lambda. */
  WEB_VIDEO_API_URL: z.string().url().optional(),
  WEB_VIDEO_API_TOKEN: z.string().min(24).optional(),

  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  // Trim every value: env vars pasted into Vercel/CI often carry a trailing
  // newline, which e.g. makes Remotion append a second `/index.html` to
  // REMOTION_SERVE_URL and breaks API keys sent as headers.
  const raw = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const listFromCsv = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
