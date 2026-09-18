-- Recurring jobs on Supabase pg_cron instead of Inngest crons.
--
-- NOT a migration and NOT applied automatically: run it once, by hand, against the PRODUCTION database only
-- (it calls the production URL). Why here: Vercel Cron on the Hobby plan only allows one run a day, and a cron
-- on Inngest stops when Inngest does (2026-09-18). Supabase is already a hard dependency of the app, so this
-- adds no new point of failure. The jobs are apps/web/src/lib/cron-jobs.ts behind /api/cron/<job>.
--
-- Order:
--   1. Set CRON_SECRET (long random string) in Vercel (Production) and redeploy.
--   2. Check by hand:  curl -H "Authorization: Bearer $CRON_SECRET" "https://www.suzu.net/api/cron/queue-watchdog?wait=1"
--   3. Store the same secret in Vault (replace the placeholder, do not commit the value):
--        select vault.create_secret('<CRON_SECRET>', 'ai_news_cron_secret');
--   4. Run this file.
--   5. Remove the three Inngest crons (apps/web/src/inngest/functions/publish-crons.ts + index.ts) and deploy.
--
-- Inspect:  select jobname, schedule, active from cron.job;
--           select * from cron.job_run_details order by start_time desc limit 20;
--           select id, status_code, error_msg, created from net._http_response order by created desc limit 20;
-- Undo:     select cron.unschedule(jobname) from cron.job where jobname like 'ai-news-%';

-- Supabase's layout: pg_cron lives in pg_catalog (objects in schema `cron`), pg_net in `extensions` (objects in schema `net`).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.ai_news_cron_call(job text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://www.suzu.net/api/cron/' || job,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ai_news_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000  -- the route answers 202 at once and works in the background
  );
$$;
-- Supabase grants EXECUTE on new public functions to the API roles by default, which would publish this one on the REST API.
revoke all on function public.ai_news_cron_call(text) from public, anon, authenticated, service_role;

-- Schedules are UTC, the same as apps/web/src/lib/cron-jobs.ts CRON_JOBS.
select cron.schedule('ai-news-poll-publications',      '*/10 * * * *', $$select public.ai_news_cron_call('poll-publications')$$);
select cron.schedule('ai-news-pull-analytics',         '30 19 * * *',  $$select public.ai_news_cron_call('pull-analytics')$$);
select cron.schedule('ai-news-refresh-channel-tokens', '15 */6 * * *', $$select public.ai_news_cron_call('refresh-channel-tokens')$$);
select cron.schedule('ai-news-queue-watchdog',         '*/5 * * * *',  $$select public.ai_news_cron_call('queue-watchdog')$$);
