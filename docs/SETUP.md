# Setup runbook (phases 1–2)

Order matters: database → auth → app deploy → storage → AWS → Inngest → Google Cloud. Each step lists the env vars it produces. Copy `.env.example` to `apps/web/.env.local` for local dev; set the same keys in Vercel (Production + Preview).

## 1. Supabase (Postgres + Vault)
1. Create project **ai-news**, region Singapore (`ap-southeast-1`). Enable **Vault** (Database → Extensions → `supabase_vault`).
2. `DATABASE_DIRECT_URL` = **session pooler** URL (port 5432, user `postgres.<ref>`, host `aws-0-ap-southeast-1.pooler.supabase.com`). The direct host `db.<ref>.supabase.co` is IPv6-only and does not resolve from most laptops.
3. Run migrations: `DATABASE_DIRECT_URL=... pnpm db:migrate`. This creates the schema, the `ai_news_app` role, RLS policies, Vault grants and seed data (`suzu.group`, default quotas, voice presets, pronunciations).
4. Set the app role password in the SQL editor: `alter role ai_news_app with password '<strong>';`
5. `DATABASE_URL` = Supavisor **transaction** pooler URL (port 6543) with user `ai_news_app.<project-ref>` and that password. The app never connects as `postgres`.
6. Enable daily backups + PITR (Pro plan). Note the restore drill is a phase 6 task.

## 2. Google Cloud (OAuth, TTS/STT, Veo)
1. Project **ai-news** under the `suzu.group` organisation.
2. OAuth consent screen: **Internal**. Scopes for now: `openid email profile`. YouTube scopes are added in phase 5 (no verification needed because the app is Internal).
3. Credentials → OAuth client ID (Web). Authorised redirect URIs: `http://localhost:3000/api/auth/callback/google`, `https://<prod-domain>/api/auth/callback/google`, and the Vercel preview pattern once known. → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. Enable APIs: Cloud Text-to-Speech, Speech-to-Text, Vertex AI (Gemini image generation = visual tier 4; Veo later), Cloud Vision (face guard).
5. Service account `ai-news-media` with roles *Cloud Speech Client*, *Vertex AI User*. Create a JSON key → `GOOGLE_APPLICATION_CREDENTIALS_JSON` (single line).
6. Face guard: enable the **Cloud Vision API** on the same project (no extra role; the service account only needs the API enabled), then turn on the feature flag **Face guard** in `/admin/integrations`. Every still from the article / other outlets / editor uploads is scanned once with `FACE_DETECTION` ($1.50 per 1 000 pictures, first 1 000 per month free; rows in `usage_costs` as `google_vision`). `check-infra.ts` sends a 1×1 PNG. With the flag off the build behaves as before (centred crops, nothing rejected).
7. AI stills: `/admin/integrations` → **Google Vertex AI (Gemini image / Veo)**: secret = the Google Cloud project id (falls back to `project_id` of the SA JSON), optional monthly spend cap; then turn on the feature flag **AI media**. Per-user daily limit is the `ai_media` quota (`/admin/quotas`, default 5). `check-infra.ts` makes a free `countTokens` call against `gemini-3.1-flash-image`. Note: Imagen predict endpoints were retired on 2026-06-30; the app uses `generateContent` on the global endpoint.
8. Voice listening test: `GOOGLE_APPLICATION_CREDENTIALS=sa.json pnpm --filter web exec tsx scripts/voice-test.ts`, open `apps/web/out/voice-test/index.html`, record the winner in `docs/PLAN.md` §1 and, if it changes, update the seed in the next migration.

## Web-video API on the office NAS (YouTube downloads)

YouTube refuses downloads from AWS (and other datacenter) IPs, so the section downloads of visual tier 2 run on a machine with a regular ISP line. `packages/media-lambda/src/server.ts` wraps the Lambda's own `web-video` / `web-video-search` handler in a small HTTP API; the app calls it when `WEB_VIDEO_API_URL` + `WEB_VIDEO_API_TOKEN` are set and falls back to the Lambda when the box is unreachable. Clips land in the same R2 bucket.

1. Build (Docker running): `bash packages/media-lambda/build-nas.sh` for Intel/AMD Synology models, `ARCH=arm64 bash packages/media-lambda/build-nas.sh` for ARM ones (check the CPU on Synology's spec page; DSM → Control Panel → Info Center shows the model). Output in `packages/media-lambda/dist/nas/` (git-ignored): `ai-news-webvideo-api-<arch>.tar`, `docker-compose.yml`, `nas.env`.
2. Open `dist/nas/nas.env`: it already holds a fresh random `API_TOKEN`; fill in `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` with the values from `apps/web/.env.local`. The build script never reads your credentials.
3. DSM → **Container Manager** → Image → Action → Import → Add from file → the `.tar`. Then copy `docker-compose.yml` and `nas.env` into one folder on the NAS (e.g. `/docker/ai-news-webvideo`) and create a **Project** from that folder. The container listens on port 8787 and restarts with the NAS.
4. HTTPS: DSM → Control Panel → Login Portal → Advanced → **Reverse Proxy** → Create: source `https`, your DDNS hostname, a port of your choice (e.g. 8443); destination `http://localhost:8787`. In the rule's *Custom Header / Advanced* tab raise the proxy timeouts (connect/send/read) to 600 s, because a download plus encode can take a few minutes on a NAS CPU. Make sure the DDNS name has a certificate (Control Panel → Security → Certificate → Let's Encrypt) and forward that one port on the office router. Do not expose 8787 itself: the token must only travel over HTTPS.
5. Check from anywhere: `curl https://<ddns-host>:8443/health` → `{"ok":true,"ytDlp":"…"}`.
6. App: set `WEB_VIDEO_API_URL=https://<ddns-host>:8443` and `WEB_VIDEO_API_TOKEN=<API_TOKEN from nas.env>` in `apps/web/.env.local` and in Vercel (Production + Preview), redeploy, and keep the **Web-video downloader** flag on.

The API only accepts a bearer token, only serves search and trimmed (≤ 120 s) downloads of public pages on YouTube / TikTok / Facebook / Vimeo / Dailymotion, and only writes to `media/<org>/<project>/webvideo/*.mp4` (and `tmp/smoke/`), so a leaked token cannot reach the NAS's network or other R2 objects. It runs two jobs at a time (`MAX_CONCURRENT`). yt-dlp is pinned at build time: when YouTube changes and downloads start failing, rebuild and re-import the image. Rotate the token by editing `nas.env` + the app env and restarting the project.

## 3. Vercel
1. Import the GitHub repo. **Root directory: `apps/web`**. Framework: Next.js. Node 22. Fluid compute on (default on Pro).
2. Env vars from `.env.example`. Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`. `APP_URL` = production URL; for previews set `APP_URL` to the `VERCEL_URL`-based value or leave Better Auth to infer from the request.
3. `ADMIN_EMAILS` = your address; sign in once, then manage roles in `/admin/users`.
4. Function max duration: the Inngest route sets `maxDuration = 300` (Pro allows up to 800 s).

## 4. Cloudflare (R2 + Browser Rendering)
1. API token with *Workers R2 Storage: Edit* and *Browser Rendering: Edit* → `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`.
2. `infra/r2/create-bucket.sh` (bucket `ai-news`, APAC hint) then `infra/r2/apply-lifecycle.sh` (plan §9 retention).
3. R2 → Manage API tokens → Object Read & Write scoped to the bucket → `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`.
4. Browser Rendering REST (phase 2 article fetch) uses the same token; `CLOUDFLARE_ACCOUNT_ID` must be set. An admin can override the token per-environment in `/admin/integrations` → Cloudflare Browser Rendering.

## 5. AWS (Remotion Lambda + media Lambda), region `ap-southeast-1`
1. IAM (the exact documents are committed under `infra/aws/`):
   - Role `remotion-lambda-role` (trust: lambda.amazonaws.com) with inline policy `infra/aws/remotion-role-policy.json`. It must include `s3:ListAllMyBuckets`; a trimmed copy fails at render time with *not authorized to perform: s3:ListAllMyBuckets*.
   - User `ai-news-vercel` with `infra/aws/remotion-user-policy.json` **plus** `infra/aws/media-lambda-invoke-policy.json` **plus** `infra/aws/sam-deployer-policy.json` (only needed on the machine that runs the media Lambda deploy; can be a separate user). Access key → `REMOTION_AWS_ACCESS_KEY_ID`, `REMOTION_AWS_SECRET_ACCESS_KEY`.
   - Regenerate the Remotion documents after a Remotion upgrade: `pnpm --filter @ai-news/video lambda:policies`.
2. Remotion: `pnpm --filter @ai-news/video lambda:deploy` (reads `apps/web/.env.local` when present, otherwise the exported `REMOTION_AWS_*` keys; it sets `NODE_PATH=./node_modules` because `@remotion/serverless-client` resolves its `remotion` peer from the caller under pnpm). It deploys a 2 GB / 4 GB-disk function and the site bundle, and prints `REMOTION_FUNCTION_NAME` + `REMOTION_SERVE_URL`. Re-run after every change to `packages/video` (bump the package version to get a new site name).
3. Check concurrency: `pnpm --filter @ai-news/video lambda:quotas` (request 1000+ concurrent Lambdas in the account if it is still at the default 10).
4. Media Lambda (needs Docker running + AWS SAM CLI, `brew install aws-sam-cli`): `IMAGE_REPO=<account>.dkr.ecr.ap-southeast-1.amazonaws.com/ai-news-media bash packages/media-lambda/deploy.sh`. Create that ECR repository once (console or `aws ecr create-repository --repository-name ai-news-media`); passing it avoids SAM's companion stack and the extra CloudFormation permissions it needs. `bash packages/media-lambda/deploy.sh` without `IMAGE_REPO` lets SAM create the repo instead. It reads the R2 and AWS values from `apps/web/.env.local`, builds the container image and deploys stack `ai-news-media`. Function name `ai-news-media` → `MEDIA_LAMBDA_FUNCTION_NAME`. Redeploy after handler changes (2026-09-17 added `web-video-search` and section-only `web-video` downloads for visual tier 2). To use web videos as material, turn on the **Web-video downloader** feature flag in `/admin/integrations`; Verified 2026-09-17 from the deployed function: `web-video-search` works (YouTube search returns results in about 4 s), but YouTube refuses **downloads** from the Lambda's AWS IP with "Sign in to confirm you're not a bot". The editor covers this with a browser capture: failed YouTube picks appear in a panel at the top of `/app/projects/<id>/edit`, one click records them in the editor's own Chrome/Edge tab (allow "share this tab", keep the tab in front; needs the R2 bucket CORS to allow the app origin, same as uploads). Until the Lambda gets a residential/ISP proxy (`yt-dlp --proxy`) or cookies, YouTube picks fail at download, the build logs the error under "video web" and moves on to stock; other sites are not affected by this block. The image uses the standalone `yt-dlp_linux` binary because the zipapp needs Python ≥ 3.10 and the base image has 3.9, and passes the Lambda's Node as yt-dlp's JS runtime. Deploy with `IMAGE_REPO` set: user `ai-news-vercel` lacks `cloudformation:DescribeStacks` on SAM's companion stack, so the no-`IMAGE_REPO` path fails.
   Keep `@remotion/lambda` / `@remotion/lambda-client` in `apps/web` pinned to the exact version of the deployed Remotion function; a mismatch fails every render with *Version mismatch*.
5. Remotion company licence: the licence key is only needed for the CLI/Studio banner; set `REMOTION_LICENSE_KEY` if you have one.

## 6. Inngest
1. Create app **ai-news** (cloud). Copy `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` to Vercel. Install the Vercel integration so previews register automatically, or sync `https://<domain>/api/inngest` manually.
2. Local: `INNGEST_DEV=1 pnpm dev` in one terminal and `pnpm --filter web inngest:dev` in another (dashboard at http://localhost:8288).

## 7. Acceptance test
0. `pnpm --filter web exec tsx --env-file=.env.local scripts/check-infra.ts` must print PASS on every line.
   Local end-to-end without the browser: `INNGEST_DEV=1 pnpm dev`, `pnpm --filter web inngest:dev`, then `INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-render.ts 6`.
1. Sign in at `/` with a `suzu.group` account → personal workspace appears on `/app`.
2. `/admin/health` shows every env var as **set**. Click **Run test render**. Within ~1 minute the row shows `done`, a cost, and a QA result of `passed`; the output link plays a 1080×1920 30 fps clip with Vietnamese text. `/admin` shows the Remotion cost in *Spend by provider*, `/admin/activity` shows `render.test_requested` and `render.test_completed`.
3. `/admin/integrations`: save an Anthropic key; the masked preview confirms the Vault round-trip.

## 8. Phase 2: fetch + script
Nothing new to provision if phase 1 passed; phase 2 reuses the Cloudflare token (Browser Rendering), R2 (`articles/<org>/<project>/` snapshots + screenshots) and the Anthropic key.
1. `pnpm db:migrate` applies `0002_phase2_fetch_script` (project presets, article confirmation, `eval_articles`, `prompt_evals`) and `0003_seed_prompt_templates` (built-in `script` and `faithfulness` templates for vi/en, promoted as v1).
2. Anthropic: save the key in `/admin/integrations` (Vault) or keep `ANTHROPIC_API_KEY` in env as the fallback. The account needs a positive credit balance; `check-infra.ts` makes a 1-token call to prove it. Optional monthly spend cap on the integration blocks calls once `usage_costs` reaches it.
3. Firecrawl (optional paid fallback): key + credits in `/admin/integrations`; the chain uses it only when Browser Rendering and plain HTTP both fail to yield ≥120 words. Credits are decremented per scrape.
4. Eval set: `/admin/evals` → add ~20 articles (mostly Vietnamese) with optional must/must-not mentions, or import from scripted projects. `/admin/prompts` → **Run eval** on a version → score shows next to the version; **Promote** / **Roll back** switch the live template. Eval runs cost roughly $0.20–0.40 per article (script + faithfulness on Opus 5).
5. Acceptance test (local): with `INNGEST_DEV=1 pnpm dev` and `pnpm --filter web inngest:dev` running,
   `INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-pipeline.ts <article-url> 60 news`
   creates a project for the first admin, waits for `fetched`, confirms the text, waits for `scripted` and prints scenes, verdicts, metadata, `usage_costs` and activity. `--fetch-only` stops after extraction.
   In the browser: `/app` → paste a URL → the project page shows extraction (method, words, flags, images), lets you edit and **confirm** the text, then **Tạo kịch bản** (30/60/90 s, tone). The review view lists scenes with per-scene verdicts; clicking a scene highlights its evidence in the article.

## 9. Phase 3: media + render
1. `pnpm db:migrate` applies `0004_phase3_media_render` (asset scene/selection columns, timeline script link + build log, render raw path).
2. Google Cloud: enable **Speech-to-Text** for the same service account (word timings for Chirp 3 HD voices). `check-infra.ts` now lists vi-VN voices and makes a zero-cost `recognize()` call.
3. `/admin/integrations`: add **Pexels** and **Pixabay** API keys (both free) and enable them; without them every scene falls back to article images / brand background. Optional: **Mubert** (`CUSTOMER_ID:ACCESS_TOKEN`, API v3) and **Slack webhook** (render notifications).
4. `/admin/music`: upload at least one licensed track per mood family (news/neutral, calm, tense, upbeat) so builds have music when Mubert is off.
5. Redeploy both Lambdas after pulling this phase: `pnpm --filter @ai-news/video lambda:deploy` (site `ai-news-v0-2-0` with the `News` composition → update `REMOTION_SERVE_URL`) and `IMAGE_REPO=… bash packages/media-lambda/deploy.sh` (adds the `mix` action).
6. R2 lifecycle: `infra/r2/lifecycle.json` gained `media/` (12 months); re-run `infra/r2/apply-lifecycle.sh` once the Cloudflare token can manage R2.
7. `/app/brand`: optional workspace brand kit (colours, fonts, logo, caption style, outro line). Defaults are used otherwise.
8. Phase 4 (editor): apply migration 0005 (`pnpm db:migrate`; adds `comments`, `project_reviews`, `projects.approved_*`, `timelines.parent_id/kind/changes` + RLS) and redeploy the Remotion site (`pnpm --filter @ai-news/video lambda:deploy` → site `ai-news-v0-3-0`, adds per-scene preview audio and `coverAtSec`; update `REMOTION_SERVE_URL`). Old versions keep rendering; the editor reconstructs their document on the fly. Inngest global concurrency is capped at 5 per function (free tier).
8. Acceptance test (local): with the dev servers running and a project in state `scripted`,
   `INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-media.ts <projectId>`
   waits for `composed`, prints the timeline (per-scene visual, timing method, music, mix loudness), then renders and prints the QA checks, cost and activity. `--assets-only` / `--render-only` / `--skip-stock` split the run.
   In the browser: project page → **Dựng video** → timeline summary with audio preview → **Kết xuất** → render row with cover, QA badges and MP4 link; **Ghim** keeps a render forever.

## 10. Phase 5: publishing
1. `pnpm db:migrate` applies `0006_phase5_publishing` (channel meta/enabled/health columns, publication platform/attempts/privacy/disclosure/url columns, `cancelled` status).
2. Google Cloud → the existing Internal OAuth client: add the redirect URI `{APP_URL}/api/channels/oauth/youtube/callback` (local: `http://localhost:3000/...`), enable **YouTube Data API v3**. No verification is needed for `youtube.upload` because the consent screen is Internal. File the quota increase (docs/REQUESTS.md) — the default 10,000 units/day covers 6 uploads.
3. Meta: in the Meta app (docs/REQUESTS.md) add *Facebook Login for Business*, set Valid OAuth Redirect URI `{APP_URL}/api/channels/oauth/meta/callback`, then save `APP_ID:APP_SECRET` in `/admin/integrations` → **Meta app** and enable it. Until App Review passes only users with a role on the app can connect and post.
4. TikTok: in the TikTok developer app add Login Kit + Content Posting API, redirect URI `{APP_URL}/api/channels/oauth/tiktok/callback`, then save `CLIENT_KEY:CLIENT_SECRET` in `/admin/integrations` → **TikTok app** and enable it. Unaudited apps post as **SELF_ONLY** only; the publish step downgrades and records it.
5. `/admin/integrations`: turn on the feature flags **Publish: YouTube Shorts** (and Facebook / Instagram / TikTok as reviews clear) and **Scheduled publishing** if wanted.
6. `/admin/channels`: pick the workspace → **+ YouTube** (sign in with the channel owner's Google account; the app needs a refresh token, so re-consent is forced) → grant the channel to the publishers who may post. **Check token** proves the Vault round-trip; **Pull analytics** runs the daily pull immediately.
7. Inngest crons register with the app sync: `poll-processing-publications` (*/10 min), `pull-publication-analytics` (19:30 UTC = 02:30 VN), `refresh-channel-tokens` (every 6 h at :15).
8. Acceptance test (local, needs a project in state `rendered` and a connected channel):
   `INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-publish.ts <projectId> <channelId> [--privacy private] [--schedule 2m] [--analytics]`
   inserts the publication row from the script's metadata, sends `publication/requested`, follows the row to `published`, prints the post URL, activity, YouTube quota units and (optionally) pulls analytics.
   In the browser: project page → **Đăng** → choose the channel → edit title / description / hashtags / privacy / schedule / AI label → **Đăng ngay**. `/app/publications` lists every attempt with analytics; `/admin/analytics` shows produced vs published and the YouTube quota used today.

## 11. Observability (create accounts now, wire later)
Sentry project (Next.js), Vercel log drain, PostHog project, Langfuse project, Resend domain, Slack incoming webhook. Keys go to `/admin/integrations` where listed, otherwise to Vercel env.

## Auto mode (2026-09-16)

Auto mode: `pnpm db:migrate` applies `0007_auto_pipeline` (`projects.auto_pipeline`). Ticking «tự động tới video» on the URL form chains fetch → script → build → render without clicks (`apps/web/src/inngest/auto-pipeline.ts`); it auto-confirms the article (≥40 words), checks script/render quotas, and pauses with `last_error` + an `auto.paused` activity when something needs a human. Approval and publishing are never automated.
