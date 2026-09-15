# ai-news

Internal app: news article URL → short vertical video → Facebook Reels / TikTok / YouTube Shorts.
Plan of record: `docs/PLAN.md`. Setup runbook: `docs/SETUP.md`. External filings: `docs/REQUESTS.md`.

## Layout
- `apps/web` – Next.js 16 (App Router, `src/`), Better Auth, Drizzle, Inngest, admin CMS at `/admin`.
  - `src/lib/fetch` – extraction chain (Browser Rendering → HTTP → Firecrawl → manual), Readability on linkedom, flags.
  - `src/lib/llm` – Anthropic client (Vault key, spend cap, cost rows), structured-output schemas, template rendering, script / faithfulness / classify calls.
  - `src/lib/prompts/defaults.ts` – built-in templates (also seeded by migration 0003); admin versions in `prompt_templates` override them.
  - `src/lib/media` – phase 3: `tts.ts` (Google TTS + STT word timings), `stock.ts` (Pexels/Pixabay), `broll.ts` (per-scene search → Haiku rank → download, shared by build + regenerate), `rank.ts`, `music.ts` (Mubert v3 + library), `brand.ts`, `timeline.ts` (pure builder, R2 keys in `src`) + `timeline-resolve.ts` (presigned URLs for Lambda / preview); phase 4: `editor.ts` (pure editor document ⇄ timeline, `audioSignature`, `describeChanges`, legacy reconstruction) + `remix.ts` (media Lambda mix for a document). Pure helpers `pronounce.ts`, `align.ts`, `captions.ts`, `editor.ts` have tests.
  - `src/lib/review.ts` – phase 4: `saveTimelineVersion` (validate doc + keys, re-mix if needed, new version with parent/kind/changes, clears approval, optimistic lock on base version), `canApprove`, faithfulness override check.
  - `src/components/editor/*` – client editor (`editor-loader.tsx` dynamic-imports it with `ssr: false` because it bundles the Remotion composition + Player): Player preview, dnd-kit scene track, inspector, comments. `review-panel.tsx` is shared with the project page.
  - `src/inngest/functions` – `fetch-article`, `generate-script`, `run-prompt-eval`, `prepare-assets`, `regenerate-scene`, `render-project` (+ phase 1 `test-render`).
- `packages/video` – Remotion compositions (`News` renders timeline JSON v1 from `src/schema.ts`, shared with the web app via `@ai-news/video/schema`) + Lambda deploy script (`ap-southeast-1`, output to R2). Bump the package version before `lambda:deploy` so the site name changes.
- `packages/media-lambda` – FFmpeg/yt-dlp Lambda (container image, AWS SAM): probe / loudnorm / duck / cover / mix / web-video. Keep `src/types.ts` in sync with `apps/web/src/lib/media-lambda.ts`.
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
- Pure helpers that need unit tests live outside `server-only` modules (`src/lib/url.ts`, `fetch/readability.ts`, `llm/render.ts`, `llm/schemas.ts`, `eval-summary.ts`, `text-match.ts`, `media/{pronounce,align,captions,timeline}.ts`).
- Timeline JSON stores R2 keys, never URLs; presign only in `timeline-resolve.ts` right before a render (and `presignMap` for the editor preview). Project media lives under `media/<org>/<project>/` (12 mo), raw renders under `tmp/` (24 h), finals under `renders/` or `pinned/`.
- Timeline versions are immutable: never update `timelines.json`; every change goes through `saveTimelineVersion` (new row, `parent_id`, `changes`). Editing the composition's props means editing `packages/video/src/schema.ts` *and* `src/lib/media/editor.ts`/`timeline.ts`; bump `packages/video` and redeploy the site when the composition itself changes (0.3.0 added preview audio + `coverAtSec`).
- Approval: `projects.approved_timeline_id` is the only "final" marker; a render advances the state to `rendered` only for that version. Publisher-only actions check `canApprove`.
- Next 16: `proxy.ts` (not middleware), route handlers under `src/app/api`. Read `apps/web/node_modules/next/dist/docs` before using unfamiliar APIs.
