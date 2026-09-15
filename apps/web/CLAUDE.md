# ai-news

Internal app: news article URL → short vertical video → Facebook Reels / TikTok / YouTube Shorts.
Plan of record: `docs/PLAN.md`. Setup runbook: `docs/SETUP.md`. External filings: `docs/REQUESTS.md`.

## Layout
- `apps/web` – Next.js 16 (App Router, `src/`), Better Auth, Drizzle, Inngest, admin CMS at `/admin`.
  - `src/lib/fetch` – extraction chain (Browser Rendering → HTTP → Firecrawl → manual), Readability on linkedom, flags.
  - `src/lib/llm` – Anthropic client (Vault key, spend cap, cost rows), structured-output schemas, template rendering, script / faithfulness / classify calls.
  - `src/lib/prompts/defaults.ts` – built-in templates (also seeded by migration 0003); admin versions in `prompt_templates` override them.
  - `src/inngest/functions` – `fetch-article`, `generate-script`, `run-prompt-eval` (+ phase 1 `test-render`).
- `packages/video` – Remotion compositions + Lambda deploy script (`ap-southeast-1`, output to R2).
- `packages/media-lambda` – FFmpeg/yt-dlp Lambda (container image, AWS SAM).
- `infra/` – R2 bucket/lifecycle scripts, IAM policy.

## Commands
- `pnpm dev` – web app. `pnpm --filter web inngest:dev` – Inngest dev server.
- `pnpm typecheck` / `pnpm lint` / `pnpm test` – all packages (CI runs these).
- `pnpm db:generate` after schema edits (CI fails if a migration is missing). `pnpm db:migrate` applies with `DATABASE_DIRECT_URL`.
- `pnpm --filter @ai-news/video lambda:deploy` – Remotion function + site. Prints env vars.

## Rules
- Output spec is fixed (1080×1920, 30 fps, CRF 18, -14 LUFS). Never trade quality for cost.
- Every user/admin action calls `logActivity`; every paid call calls `recordUsageCost`.
- Org-scoped queries go through `withOrgContext`; admin/cross-workspace through `withServiceContext`.
- Secrets: deployment credentials in Vercel env; admin-editable keys and channel tokens in Supabase Vault (never in tables).
- Inngest v4: triggers in options, `eventType()` for typed events, keep `checkpointing.maxRuntime` below the route `maxDuration`. Set `projects.busy_step` when a step starts and clear it in the function and in `onFailure`; the UI treats a flag older than 15 min as stale.
- Claude calls: `claude-opus-5` for script/faithfulness (adaptive thinking, structured outputs via `client.beta.messages.parse`, cached system blocks, server-side refusal fallback), `claude-haiku-4-5` for classification. Map billing/auth/400 errors to `NonRetriableError` (`isPermanentLlmError`).
- Pure helpers that need unit tests live outside `server-only` modules (`src/lib/url.ts`, `fetch/readability.ts`, `llm/render.ts`, `llm/schemas.ts`, `eval-summary.ts`, `text-match.ts`).
- Next 16: `proxy.ts` (not middleware), route handlers under `src/app/api`. Read `apps/web/node_modules/next/dist/docs` before using unfamiliar APIs.
