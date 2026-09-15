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
4. Enable APIs: Cloud Text-to-Speech, Speech-to-Text, Vertex AI (Veo/Imagen, phase 6).
5. Service account `ai-news-media` with roles *Cloud Speech Client*, *Vertex AI User*. Create a JSON key → `GOOGLE_APPLICATION_CREDENTIALS_JSON` (single line).
6. Voice listening test: `GOOGLE_APPLICATION_CREDENTIALS=sa.json pnpm --filter web exec tsx scripts/voice-test.ts`, open `apps/web/out/voice-test/index.html`, record the winner in `docs/PLAN.md` §1 and, if it changes, update the seed in the next migration.

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
2. Remotion: with those keys exported, `pnpm --filter @ai-news/video lambda:deploy`. It deploys a 2 GB / 4 GB-disk function and the site bundle, and prints `REMOTION_FUNCTION_NAME` + `REMOTION_SERVE_URL`. Re-run after every change to `packages/video` (bump the package version to get a new site name).
3. Check concurrency: `pnpm --filter @ai-news/video lambda:quotas` (request 1000+ concurrent Lambdas in the account if it is still at the default 10).
4. Media Lambda (needs Docker running + AWS SAM CLI, `brew install aws-sam-cli`): `IMAGE_REPO=<account>.dkr.ecr.ap-southeast-1.amazonaws.com/ai-news-media bash packages/media-lambda/deploy.sh`. Create that ECR repository once (console or `aws ecr create-repository --repository-name ai-news-media`); passing it avoids SAM's companion stack and the extra CloudFormation permissions it needs. `bash packages/media-lambda/deploy.sh` without `IMAGE_REPO` lets SAM create the repo instead. It reads the R2 and AWS values from `apps/web/.env.local`, builds the container image and deploys stack `ai-news-media`. Function name `ai-news-media` → `MEDIA_LAMBDA_FUNCTION_NAME`.
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

## 9. Observability (create accounts now, wire in phase 3)
Sentry project (Next.js), Vercel log drain, PostHog project, Langfuse project, Resend domain, Slack incoming webhook. Keys go to `/admin/integrations` where listed, otherwise to Vercel env.
