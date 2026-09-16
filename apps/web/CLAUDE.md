# ai-news

Internal app: news article URL → short vertical video → Facebook Reels / TikTok / YouTube Shorts.
Plan of record: `docs/PLAN.md`. Setup runbook: `docs/SETUP.md`. External filings: `docs/REQUESTS.md`.

## Layout
- `apps/web` – Next.js 16 (App Router, `src/`), Better Auth, Drizzle, Inngest, admin CMS at `/admin`.
  - `src/lib/fetch` – extraction chain (Browser Rendering → HTTP → Firecrawl → manual), Readability on linkedom, flags.
  - `src/lib/llm` – Anthropic client (Vault key, spend cap, cost rows), structured-output schemas, template rendering, script / faithfulness / classify calls.
  - `src/lib/prompts/defaults.ts` – built-in templates (also seeded by migration 0003); admin versions in `prompt_templates` override them.
  - `src/lib/media` – phase 3: `tts.ts` (Google TTS + STT word timings), `stock.ts` (Pexels/Pixabay), `broll.ts` (per-scene search → Haiku rank → download, shared by build + regenerate), `rank.ts` (Haiku ranks B-roll thumbnails; `assignImages` maps article/related images to scenes, each once), `related.ts` (other outlets' images for the same story: Firecrawl search → Bing News RSS, plain HTTP fetch, stored as `article`/`related` assets), `music.ts` (Mubert v3 + library), `brand.ts`, `timeline.ts` (pure builder, R2 keys in `src`; `shotsNeeded`/`layoutShots` cut every scene into ≤ 5 s shots) + `timeline-resolve.ts` (presigned URLs for Lambda / preview); phase 4: `editor.ts` (pure editor document ⇄ timeline, `audioSignature`, `describeChanges`, legacy reconstruction) + `remix.ts` (media Lambda mix for a document). Pure helpers `pronounce.ts`, `align.ts`, `captions.ts`, `editor.ts` have tests.
  - `src/lib/publish` – phase 5: `platforms.ts` (pure: platform catalogue + limits, metadata defaults with attribution/disclosure, idempotency key, TikTok chunk plan, Vietnam datetime parsing; tested), `state.ts` (signed OAuth state; tested), `oauth.ts` (authorize URLs, code exchange → discovered channels, Vault token store `channel:<id>`, refresh, probe), `youtube.ts` / `meta.ts` / `tiktok.ts` (`PlatformClient`: start / check / analytics), `service.ts` (publication lifecycle shared by the Inngest function, the crons and admin actions). OAuth routes under `src/app/api/channels/oauth/[provider]`.
  - `src/lib/review.ts` – phase 4: `saveTimelineVersion` (validate doc + keys, re-mix if needed, new version with parent/kind/changes, clears approval, optimistic lock on base version), `canApprove`, faithfulness override check.
  - `src/components/editor/*` – client editor (`editor-loader.tsx` dynamic-imports it with `ssr: false` because it bundles the Remotion composition + Player): Player preview, dnd-kit scene track, inspector, comments. `review-panel.tsx` is shared with the project page.
  - `src/inngest/functions` – `fetch-article`, `generate-script`, `run-prompt-eval`, `prepare-assets`, `regenerate-scene`, `render-project`, `publish-publication` (+ crons in `publish-crons.ts`: processing poll, daily analytics, token refresh; phase 1 `test-render`).
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
- Timeline versions are immutable: never update `timelines.json`; every change goes through `saveTimelineVersion` (new row, `parent_id`, `changes`). Editing the composition's props means editing `packages/video/src/schema.ts` *and* `src/lib/media/editor.ts`/`timeline.ts`; bump `packages/video` and redeploy the site when the composition itself changes (0.3.0 added preview audio + `coverAtSec`; 0.4.0 added `scenes[].shots`).
- Visuals: a scene is `visual` (first shot) + `shots[]`; the builder splits the scene time equally, so a scene needs `shotsNeeded(voiceMs)` pictures for the ≤ 5 s cadence, and a picture must not repeat within a video (`prepare-assets` assigns each image once; the editor warns). Uploads go browser → presigned PUT → R2 (`createUploadUrl`/`registerUpload`; bucket CORS from `infra/r2/cors.json`, add the production origin), URL imports go through `importVisualFromUrl` (server download, 80 MB cap). Both become `upload` assets under `media/<org>/<project>/uploads/`.
- Voice: platform presets from migration 0008 (Fenrir 1.22 default, Puck 1.20, Charon/Kore 1.15); script template v2 (punchy) is promoted by the same migration only when the admin never created a version. Keep `src/lib/prompts/defaults.ts` in sync with the seeded text.
- Approval: `projects.approved_timeline_id` is the only "final" marker; a render advances the state to `rendered` only for that version. Publisher-only actions check `canApprove`.
- Publishing: one `publications` row per attempt (`idempotency_key` = render + channel + attempt; retry bumps `attempts` and re-keys the same row). Only the finished render of the approved timeline can be published; `platform_post_id` is written in the same step as the upload; `metadata.handles` carries per-platform ids while processing. Channel tokens are Vault secrets named `channel:<id>` (never in tables); use `channelAccessToken()` which refreshes on demand. Platform errors: throw `PlatformError(msg, permanent)`; permanent ones become `NonRetriableError`. YouTube quota units go to `usage_costs` as provider `youtube_api`.
- Next 16: `proxy.ts` (not middleware), route handlers under `src/app/api`. Read `apps/web/node_modules/next/dist/docs` before using unfamiliar APIs.
