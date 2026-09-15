# ai-news

Internal app: news article URL → short vertical video → Facebook Reels / TikTok / YouTube Shorts.
Plan of record: `docs/PLAN.md`. Setup runbook: `docs/SETUP.md`. External filings: `docs/REQUESTS.md`.

## Layout
- `apps/web` – Next.js 16 (App Router, `src/`), Better Auth, Drizzle, Inngest, admin CMS at `/admin`.
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
- Inngest v4: triggers in options, `eventType()` for typed events, keep `checkpointing.maxRuntime` below the route `maxDuration`.
- Next 16: `proxy.ts` (not middleware), route handlers under `src/app/api`. Read `apps/web/node_modules/next/dist/docs` before using unfamiliar APIs.
