# ai-news: Implementation Plan

Internal web app: news article URL → short vertical video → Facebook Reels, TikTok, YouTube Shorts.
Updated 2026-09-16.

## 1. Fixed decisions

- Web app (PWA), online only, all data in the cloud. No desktop build.
- Users: `suzu.group` Google Workspace accounts. Allowlist editable in admin.
- Languages: Vietnamese primary, English secondary.
- Volume: 20 to 50 videos/day.
- Workspaces: one personal workspace per user. Team workspaces later (phase 6).
- Output: 1080x1920, 30 fps, H.264 High, CRF 18, AAC 192 kbps, -14 LUFS, -1 dBTP. Never lowered for cost.
- Default Vietnamese voice: `vi-VN-Chirp3-HD-Charon`, rate 1.0, news-narrator preset. Alternate `vi-VN-Chirp3-HD-Kore`. SSML fallback `vi-VN-Neural2-D`. Phase 1 listening test may swap within Chirp 3 HD.
- Media sourcing: stock APIs, article media, AI generation, optional web-video downloader (flag). Legal cleared.
- Shared API keys and platform app credentials managed in admin, stored in Supabase Vault.
- Social channels connected per workspace by admin, granted to users. OAuth consent by channel owner.
- Vercel Pro, 1 seat. Remotion company licence. Firecrawl free tier.

## 2. Stack

| Concern | Choice |
|---|---|
| App | Next.js, React, TypeScript, Tailwind, shadcn/ui on Vercel (Node runtime, Fluid compute). Admin CMS at `/admin`. |
| Auth | Better Auth: Google provider, `hd` + email-domain allowlist enforced in before-hooks, organization plugin (workspaces, roles), admin plugin, Drizzle adapter, DB sessions with cookie cache. |
| API | Route handlers, Zod, Drizzle ORM. |
| Database | Postgres on Supabase (Supavisor pooling), RLS keyed on organization ID, Vault for runtime secrets and OAuth tokens. |
| Jobs | Inngest: durable functions, fan-out events, sleep/poll, cron. |
| Storage | Cloudflare R2 via S3 API, presigned URLs, lifecycle rules. |
| Render | Remotion Lambda, `ap-southeast-1`, 2 GB functions, chunked; output direct to R2 via S3-compatible output provider. S3 bucket for site bundle only. |
| Media utility | AWS Lambda + FFmpeg layer + yt-dlp: loudnorm, ducking, cover frame, QA probe, web-video trim. |
| Editor | Remotion Player preview + custom track UI (dnd-kit). Timeline is versioned JSON. |
| Article fetch | Cloudflare Browser Rendering REST + Mozilla Readability → Firecrawl → manual paste. |
| LLM | Claude Opus 5 `claude-opus-5` (script, faithfulness, metadata): structured outputs, adaptive thinking, prompt caching, server-side fallback. Haiku 4.5 `claude-haiku-4-5` for ranking, language detection, sensitive-topic flag. |
| Stock | Pexels, Pixabay. English search terms. Min 1080p, vertical or croppable. |
| AI media | Google Veo (video), Imagen (stills). Per-project cap. |
| TTS | Google Cloud Text-to-Speech, Node client. Word timings: SSML `<mark>` per word on Neural2; Speech-to-Text on Chirp 3 HD. |
| Fonts | Be Vietnam Pro, Inter, Roboto, Noto Sans (verified Vietnamese glyphs). |
| Music | Mubert API; admin-uploaded library fallback. |
| Publish | YouTube Data API v3, Meta Graph API, TikTok Content Posting API. |
| Secrets | Vercel env vars for deployment credentials (AWS, Google SA, Inngest, Cloudflare). Vault for admin-editable keys and channel tokens. |
| Observability | Sentry, Vercel log drain, CloudWatch (Lambdas), Inngest dashboard, Langfuse (LLM), PostHog. |
| Notifications | Resend email, Slack webhook. |

## 3. Architecture

```
VERCEL: Next.js app + /admin + API + Better Auth + Inngest functions
  pipeline: fetch → script → assets(fan-out) → tts → captions → music → compose → render → publish
  cron: scheduled publish, token refresh, analytics pull, cleanup
   │ S3 API              │ invoke/poll                 │ gRPC/REST
CLOUDFLARE              AWS ap-southeast-1            GOOGLE CLOUD
  R2 (all files)          Remotion Lambda → R2          TTS, STT, Veo/Imagen
  Browser Rendering       Media Lambda (FFmpeg)         Internal OAuth client (YouTube)
External: Supabase Postgres+Vault, Anthropic, Inngest, Pexels, Pixabay, Mubert, Firecrawl, Meta, TikTok
```

Trust: Inngest signing key; Lambdas via scoped IAM; Google via service account; browser gets presigned R2 URLs only.

## 4. Pipeline

States: `created → fetched → scripted → assets_ready → composed → in_review → approved → rendered → published`.
Every step output is persisted; any step can be re-run.

1. **Fetch.** Canonicalise URL, strip tracking. Duplicate check org-wide. Browser Rendering + Readability → Firecrawl → manual paste. Snapshot HTML + screenshot to R2. Detect paywall, live blog, video-only. Detect language (`vi`/`en`, overridable). User confirms text.
2. **Script.** Opus 5, structured output, per-language prompt templates from admin. Output: hook, scenes (VO text, on-screen text, English B-roll terms, est. duration, supporting sentence), CTA, per-platform title/description/hashtags. Presets: 30/60/90 s, tone. Vietnamese: spoken numbers/dates, expand abbreviations (TP.HCM), keep proper nouns. Faithfulness pass marks unsupported scenes; publishing them requires publisher override. Cache system prompt + article across calls.
3. **Assets.** A-roll from article media. B-roll: Pexels/Pixabay per scene, one Inngest event per candidate download to R2, Haiku ranks thumbnails. Optional web video (flag) and Veo/Imagen (cap). Store provider, ID, licence, source URL, hash, dimensions, duration, origin. Dedupe by hash.
4. **TTS + captions.** Voice preset, pronunciation dictionary (SSML on Neural2, text substitution on Chirp). Word timings per voice type. VO normalised to -16 LUFS by media Lambda. Captions in brand style inside safe zones, diacritic-aware line height.
5. **Music.** Mubert by mood + duration, else library. Normalised, ducked -12 dB under VO by media Lambda.
6. **Compose.** Timeline JSON: video, overlays, captions, VO, music, logo, intro, outro. Brand kit + safe zones.
7. **Review.** Editor: reorder, trim, swap clip, regenerate one scene's B-roll or VO, change music, edit captions, pick cover. Faithfulness view beside article. Each save = new version. Comments.
8. **Approve.** Editor drafts, publisher approves. Logged.
9. **Render.** Invoke Remotion Lambda with timeline + R2 URLs; sleep/poll. Media Lambda: final loudnorm, cover frame, QA probe (resolution, duration, loudness, black frames). Fail with reason if QA fails. Notify.
10. **Publish.** Now or scheduled (Inngest delayed event). Idempotency key per attempt; store platform post ID. Poll processing status. Apply AI-disclosure flag. Daily analytics pull.

## 5. Data model

Better Auth core: `user` (+ `domain`, `platform_role`, `last_login`), `session`, `account`, `verification`.
Organization plugin as workspaces: `organization` (+ `kind`: `personal`|`team`), `member` (role: viewer|editor|publisher|admin via access-control builder), `invitation`.

| Table | Key fields |
|---|---|
| `projects` | org, owner, url, language, state, ai_disclosure, inngest_run_id |
| `articles` | project, canonical_url, title, author, published_at, language, text, images, snapshot_path |
| `scripts` | project, version, scenes_json, template_version, model, tokens, cost, faithfulness_json |
| `assets` | org, provider, provider_id, licence, source_url, r2_path, hash, width, height, duration, origin |
| `timelines` | project, version, json, created_by |
| `renders` | timeline_version, remotion_render_id, output_path, cover_path, duration, cost, qa_json, status |
| `channels` | org, platform, external_id, name, vault_ref, expires_at |
| `channel_grants` | channel, user |
| `publications` | channel, render, platform_post_id, status, scheduled_at, published_at, analytics_json |
| `brand_kits` | org, logo, fonts, colours, caption_style, intro, outro, lower_third |
| `voice_presets` | org, voice, language, rate, pitch, ssml_supported |
| `pronunciations` | org, language, term, replacement |
| `prompt_templates` | purpose, language, version, body, promoted |
| `music_library` | path, mood_tags, licence |
| `integrations` | provider, vault_ref, enabled, spend_cap, credits_remaining |
| `quotas` | scope (user|org), scope_id, resource, daily_limit |
| `activity_events` | actor, org, project, type, payload, created_at (append-only) |
| `usage_costs` | provider, units, cost, user, org, project, created_at |

RLS on all org-scoped tables. Server sets acting user + active org per transaction; service role only server-side.

## 6. Admin CMS (`/admin`, platform_role = admin)

- Users (admin plugin: list, role, ban, impersonate), allowed domains, workspaces, quotas.
- Channels: OAuth connect, grant to users, token health.
- Integrations: keys to Vault, enable/disable, spend caps, Firecrawl credits.
- Feature flags: web-video downloader, AI media, scheduling, per platform.
- Prompt templates per language: edit, version, eval run, promote, rollback.
- Brand kits, voice presets, pronunciations, music library.
- Activity log (filter, export). Cost dashboard (provider/user/org/project/day, incl. per-render).
- Analytics: produced, published, platform performance.
- Retention settings. Health: Inngest runs, failed steps + retry, Lambda errors, YouTube quota used.

## 7. Publishing

| Platform | Requirements |
|---|---|
| YouTube Shorts | `videos.insert`, ≤3 min, `#Shorts`. OAuth consent screen **Internal** on `suzu.group` org (no verification). Quota: 1,600 units/upload, default 10,000/day → request ~80,000/day in phase 1. Synthetic-content flag when applicable. |
| Facebook Reels | Graph API, Page: `pages_manage_posts`, `pages_read_engagement`, `publish_video`. ≤90 s. Business Verification + App Review needed for public posting; apply phase 1. |
| Instagram Reels | `instagram_content_publish`, professional account linked to Page. ≤3 min. Same review. |
| TikTok | Content Posting API Direct Post. Private-only until audit passes; apply phase 1. Target ≤60 s. |

Common: tokens in Vault, cron refresh, admin alert on failure; per-platform metadata limits in UI; idempotency key per attempt.

## 8. Content rules

Source attribution in video and caption. Licence stored per asset/track. AI-disclosure flag per project. Faithfulness gate with logged override. Sensitive-topic flag (elections, health, legal, minors) routed to publisher. Activity log retention 12 months, configurable.

## 9. Operations

**Cost/month at 1,500 videos:** Vercel $20, Inngest $0–50, Supabase $25, R2 $2–5, Browser Rendering $0–5, Remotion Lambda $40–80, media Lambda <$5, Remotion licence (list), Google TTS ~$50, STT ~$25, Opus 5 $300–600, Haiku <$20, Mubert (plan), tooling $0–50. Total ≈ $500–900. Cost levers: caching, fewer regenerations, quotas. Not levers: resolution, fps, CRF, voice tier, script model.

**Quotas/user/day:** 20 scripts, 5 AI media, 30 render minutes, 10 publishes.

**Lifecycle:** unused candidates 7 d, intermediates 24 h, superseded timeline versions 90 d, final renders 12 mo unless pinned.

**Backups:** Supabase daily + PITR, R2 versioning on final-render bucket, quarterly restore drill.

**Quality:** 20-article eval set (mostly Vietnamese) on every prompt change; visual regression render per brand kit per deploy; render QA probe on every render; concurrency via single-owner projects + optimistic locking.

## 10. Roadmap

**Phase 1: foundation**
- Repo, CI, Vercel project, preview deploys.
- Better Auth (Google, allowlist hooks, organization plugin + custom roles, admin plugin). Personal org on first login.
- Supabase Postgres, Drizzle schema, RLS, Vault.
- Inngest wired; activity_events + usage_costs from first commit.
- Admin: domains, users, integrations→Vault, prompt templates, quotas.
- AWS: Remotion Lambda (R2 output) + media Lambda; end-to-end test render from an Inngest step.
- R2 bucket + lifecycle; Browser Rendering token.
- Vietnamese voice listening test (all Chirp 3 HD vi-VN + Neural2-D) → confirm default.
- File: YouTube quota increase, Meta App Review + Business Verification, TikTok audit.

**Phase 2: fetch + script.** Extraction chain, script generation per language, faithfulness check + review view, eval set + promotion flow. *Built 2026-09-16:* `project/fetch.requested` → Browser Rendering → HTTP → Firecrawl → manual paste, Readability + JSON-LD metadata, paywall/live-blog/video-only flags, Haiku language + sensitive-topic classification, R2 snapshot + screenshot, user confirms text; `project/script.requested` → Opus 5 structured script (hook/body/CTA scenes, English B-roll terms, per-platform metadata) → Opus 5 faithfulness verdict per scene → review view with evidence highlighting; `/admin/evals` eval set + `prompt/eval.requested` runs with a 0–100 score shown at promotion.

**Phase 3: media + render.** Stock search/fan-out/ranking/dedupe, article A-roll, TTS + word timings + pronunciations + captions, Mubert + library, audio normalisation, brand kits, one Remotion template, full render path with QA + notifications. *Built 2026-09-16:* `project/assets.requested` → per-scene Google TTS (Chirp 3 HD, LINEAR16) with the pronunciation dictionary, word timings from SSML marks (Neural2) or Speech-to-Text alignment (Chirp), article images as A-roll, Pexels/Pixabay search per scene → Haiku ranks thumbnails → top 2 downloaded to R2 and deduped org-wide by provider id + hash, music from Mubert v3 or the admin library, media Lambda `mix` (VO −16 LUFS, music looped/faded/ducked −12 dB, limiter) → timeline JSON v1 version (`timelines`, project → `composed`); `project/render.requested` → Remotion Lambda `News` composition (headline cards, word-highlighted captions in safe zones, source line, logo, outro credits) → media Lambda loudnorm −14 LUFS → cover frame → QA probe (resolution, fps, duration, loudness, true peak, black frames) → `renders` row, `usage_costs`, Slack notification; `/app/brand` brand kit, `/admin/music` library, render-minute quota, pin-to-keep.

**Phase 4: editor.** Timeline JSON versioning, editor UI, comments, approval flow. *Built 2026-09-16:* every timeline version carries an editor document (`timelines.build_json.doc`: scenes with voice file + word timings, visual, caption chunks, hold, music, cover; pre-phase-4 versions are reconstructed from their JSON) and a save rebuilds timeline JSON v1 from it (`buildFromDoc`), re-mixing audio on the media Lambda only when the audio layout changed (`audioSignature`), with `parent_id`, `kind` (built/edited/regenerated) and a human-readable `changes` list; optimistic lock on the base version. `/app/projects/[id]/edit`: Remotion Player preview of the same `News` composition (per-scene voice playback when the mix is stale), dnd-kit scene track (reorder, remove), inspector (headline, swap clip/image from every asset fetched for the project or solid, trim start, Ken Burns, hold, per-chunk caption text edits, faithfulness verdict), per-scene voice re-synthesis with edited text and B-roll re-search via `project/scene.regenerate.requested` → `regenerate-scene`, music from the library or a fresh Mubert/library pick, cover frame pick (`coverAtSec`, used by the render step), version history with restore. Comments (`comments`: scene + timestamp anchors, resolve). Approval (`project_reviews`, `projects.approved_timeline_id`): editor submits → `in_review`, publisher approves (faithfulness override required and logged when scenes are unsupported) → `approved`, or requests changes → `composed`; any new version clears the approval; only a render of the approved version moves the project to `rendered`, other renders are previews.

**Phase 5: publishing.** YouTube first; Meta and TikTok as reviews clear. Scheduling, idempotent publish, status polling, disclosure flags, analytics pull + dashboard. *Built 2026-09-16:* channels connected per workspace by a platform admin at `/admin/channels` through signed-state OAuth routes (`/api/channels/oauth/{youtube|meta|tiktok}/{start,callback}`; Google uses the Internal client from env with `youtube.upload` + `youtube.readonly`, Meta and TikTok app credentials come from `/admin/integrations` → Vault; one Meta login yields a channel per Page plus one per linked Instagram account), tokens stored as `channel:<id>` Vault secrets, grants per user, pause / check / disconnect, a 6-hourly cron that refreshes tokens expiring within 24 h, probes the rest and alerts Slack. Publishing (`publications`, one row per attempt with `idempotency_key = pub:<render>:<channel>:<attempt>`): publisher-level role + grant + platform feature flag + daily `publishes` quota, only the finished render of the approved timeline, per-platform metadata defaults from the script's `metadata` block with source attribution and AI-disclosure line (§8), limits validated (title/description/hashtags/duration), privacy, optional schedule (flag; Vietnam wall-clock → `step.sleepUntil`, cancellable via `publication/cancelled`); `publish-publication` uploads once (YouTube resumable upload streamed from R2 with `containsSyntheticMedia`; Facebook Reels start → `file_url` pull → finish; Instagram Reels container → poll → `media_publish`; TikTok Direct Post FILE_UPLOAD in ranged chunks with `is_aigc`, privacy downgraded to the creator's allowed level and recorded), stores the platform post id immediately, polls processing inline for 6 min then hands over to a 10-minute cron; first success moves the project to `published`. Daily 02:30 (VN) analytics pull per channel into `publications.analytics_json` (views/likes/comments/shares + raw); `/app/publications` workspace dashboard, `/admin/analytics` (produced vs published, per platform, per day, top posts, YouTube quota units used today via `usage_costs` provider `youtube_api`). Project page gains an "Đăng" card with per-channel forms, attempt list, cancel / retry.

**Phase 6: extras + hardening.** Web-video downloader (flag), AI media (cap), team workspaces, lifecycle enforcement, restore drill, visual regression, render load test, runbook.
