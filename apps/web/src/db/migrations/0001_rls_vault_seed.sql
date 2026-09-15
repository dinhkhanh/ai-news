-- Application DB role, row-level security, Vault grants and seed data.
-- Applied by `pnpm db:migrate` with DATABASE_DIRECT_URL (postgres role).

-- ---------------------------------------------------------------------------
-- 1. Application role. The app connects as ai_news_app (no BYPASSRLS), so the
--    policies below actually apply. Set its password after the first migrate:
--      alter role ai_news_app with password '...';
--    and use it in DATABASE_URL (pooled) on Vercel.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_news_app') then
    create role ai_news_app login nobypassrls noinherit;
  end if;
end $$;
--> statement-breakpoint
grant usage on schema public to ai_news_app;
--> statement-breakpoint
grant select, insert, update, delete on all tables in schema public to ai_news_app;
--> statement-breakpoint
grant usage, select on all sequences in schema public to ai_news_app;
--> statement-breakpoint
alter default privileges in schema public grant select, insert, update, delete on tables to ai_news_app;
--> statement-breakpoint
alter default privileges in schema public grant usage, select on sequences to ai_news_app;
--> statement-breakpoint
-- Append-only logs: the app role may never update or delete them.
revoke update, delete on activity_events, usage_costs from ai_news_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Vault access (Supabase). The app reads/writes shared API keys and channel
--    tokens through vault.* functions only; raw ciphertext is never selected.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    grant usage on schema vault to ai_news_app;
    grant select on vault.decrypted_secrets to ai_news_app;
    grant select, delete on vault.secrets to ai_news_app;
    grant execute on function vault.create_secret(text, text, text, uuid) to ai_news_app;
    grant execute on function vault.update_secret(uuid, text, text, text, uuid) to ai_news_app;
  else
    raise notice 'vault schema not present (local Postgres?) - skipping vault grants';
  end if;
exception when others then
  raise notice 'vault grants skipped: %', sqlerrm;
end $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. RLS helpers. The server sets these per transaction (src/db/context.ts):
--      app.role    'user' | 'service'
--      app.org_id  active workspace id
--      app.user_id acting user id
-- ---------------------------------------------------------------------------
create or replace function app_is_service() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.role', true), '') = 'service'
$$;
--> statement-breakpoint
create or replace function app_org_id() returns text
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')
$$;
--> statement-breakpoint
create or replace function app_user_id() returns text
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')
$$;
--> statement-breakpoint

-- Org-scoped tables: readable/writable only inside the active workspace,
-- or by the service context. Tables with nullable organization_id
-- (voice_presets, pronunciations) also expose platform-wide rows.
do $$
declare
  t text;
begin
  foreach t in array array[
    'projects','articles','scripts','assets','timelines','renders',
    'channels','channel_grants','publications','brand_kits'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_isolation', t);
    execute format(
      'create policy %I on %I for all to ai_news_app
         using (app_is_service() or organization_id = app_org_id())
         with check (app_is_service() or organization_id = app_org_id())',
      t || '_org_isolation', t);
  end loop;

  foreach t in array array['voice_presets','pronunciations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_or_global', t);
    execute format(
      'create policy %I on %I for all to ai_news_app
         using (app_is_service() or organization_id is null or organization_id = app_org_id())
         with check (app_is_service() or organization_id = app_org_id())',
      t || '_org_or_global', t);
  end loop;
end $$;
--> statement-breakpoint

-- Append-only logs: insert from any context; read own-workspace rows or service.
alter table activity_events enable row level security;
--> statement-breakpoint
drop policy if exists activity_events_insert on activity_events;
--> statement-breakpoint
create policy activity_events_insert on activity_events for insert to ai_news_app with check (true);
--> statement-breakpoint
drop policy if exists activity_events_select on activity_events;
--> statement-breakpoint
create policy activity_events_select on activity_events for select to ai_news_app
  using (app_is_service() or organization_id = app_org_id() or actor_id = app_user_id());
--> statement-breakpoint
alter table usage_costs enable row level security;
--> statement-breakpoint
drop policy if exists usage_costs_insert on usage_costs;
--> statement-breakpoint
create policy usage_costs_insert on usage_costs for insert to ai_news_app with check (true);
--> statement-breakpoint
drop policy if exists usage_costs_select on usage_costs;
--> statement-breakpoint
create policy usage_costs_select on usage_costs for select to ai_news_app
  using (app_is_service() or organization_id = app_org_id() or user_id = app_user_id());
--> statement-breakpoint

-- Optimistic locking helper for projects (single-owner + lock_version).
create or replace function projects_bump_lock_version() returns trigger
language plpgsql as $$
begin
  new.lock_version := old.lock_version + 1;
  new.updated_at := now();
  return new;
end $$;
--> statement-breakpoint
drop trigger if exists projects_lock_version on projects;
--> statement-breakpoint
create trigger projects_lock_version before update on projects
  for each row execute function projects_bump_lock_version();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Seed data
-- ---------------------------------------------------------------------------
insert into allowed_domains (domain, note) values ('suzu.group', 'Primary Google Workspace org')
on conflict do nothing;
--> statement-breakpoint
insert into quotas (scope, scope_id, resource, daily_limit) values
  ('user', '*', 'scripts', 20),
  ('user', '*', 'ai_media', 5),
  ('user', '*', 'render_minutes', 30),
  ('user', '*', 'publishes', 10)
on conflict do nothing;
--> statement-breakpoint
insert into feature_flags (key, enabled, description) values
  ('web_video_downloader', false, 'Allow trimming clips from web videos as B-roll.'),
  ('ai_media', false, 'Allow AI-generated B-roll, subject to per-project cap.'),
  ('scheduling', false, 'Allow publish-at-time via delayed events.'),
  ('publish_youtube', false, ''),
  ('publish_facebook', false, ''),
  ('publish_instagram', false, ''),
  ('publish_tiktok', false, '')
on conflict do nothing;
--> statement-breakpoint
-- Platform voice presets (organization_id null = available to every workspace).
-- Default per docs/PLAN.md §1; phase 1 listening test may swap within Chirp 3 HD.
insert into voice_presets (organization_id, name, language, voice, rate, pitch, ssml_supported, is_default) values
  (null, 'Người dẫn tin (Charon)', 'vi', 'vi-VN-Chirp3-HD-Charon', 1.00, 0, false, true),
  (null, 'Người dẫn tin (Kore)',   'vi', 'vi-VN-Chirp3-HD-Kore',   1.00, 0, false, false),
  (null, 'SSML fallback (Neural2-D)', 'vi', 'vi-VN-Neural2-D',     1.00, 0, true,  false),
  (null, 'News narrator (Charon)', 'en', 'en-US-Chirp3-HD-Charon', 1.00, 0, false, true),
  (null, 'SSML fallback (Neural2-D)', 'en', 'en-US-Neural2-D',     1.00, 0, true,  false)
on conflict do nothing;
--> statement-breakpoint
-- Common Vietnamese abbreviations expanded for TTS (text substitution on Chirp, SSML on Neural2).
insert into pronunciations (organization_id, language, term, replacement) values
  (null, 'vi', 'TP.HCM', 'Thành phố Hồ Chí Minh'),
  (null, 'vi', 'TP. HCM', 'Thành phố Hồ Chí Minh'),
  (null, 'vi', 'UBND', 'Ủy ban nhân dân'),
  (null, 'vi', 'HĐND', 'Hội đồng nhân dân'),
  (null, 'vi', 'BTC', 'Ban tổ chức'),
  (null, 'vi', 'GDP', 'GDP'),
  (null, 'vi', 'USD', 'đô la Mỹ'),
  (null, 'vi', 'VND', 'đồng')
on conflict do nothing;
