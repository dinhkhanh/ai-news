-- Close the Supabase Data API door and put every public table behind RLS.
--
-- The app only ever talks to Postgres as ai_news_app (DATABASE_URL); it never uses the
-- Supabase REST/GraphQL API. Supabase's default privileges still gave the API roles
-- (anon, authenticated, service_role) ALL on every table we created, and the 15 platform /
-- Better Auth tables had no RLS, so anyone holding the project's anon key could read and
-- write "user", session, account (OAuth tokens), integrations, quotas, ... over
-- https://<ref>.supabase.co/rest/v1. The org-scoped tables were only saved by having RLS on
-- with no policy for those roles.

-- ---------------------------------------------------------------------------
-- 1. API roles lose every privilege in public, now and for future objects.
--    (Roles are absent on a plain Postgres: CI, PGlite.)
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Functions: nothing is executable by PUBLIC any more. A per-schema default cannot
--    take away the built-in PUBLIC execute, hence the schema-less form; the app role
--    gets execute on future public functions instead.
-- ---------------------------------------------------------------------------
alter default privileges revoke execute on functions from public;
--> statement-breakpoint
alter default privileges in schema public grant execute on functions to ai_news_app;
--> statement-breakpoint
do $$
declare
  f text;
begin
  foreach f in array array['app_is_service()', 'app_org_id()', 'app_user_id()', 'projects_bump_lock_version()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to ai_news_app', f);
    -- Pin the search_path (Supabase linter 0011). The bodies only use pg_catalog.
    execute format('alter function %s set search_path = ''''', f);
  end loop;
end $$;
--> statement-breakpoint

-- A function with a SET clause is no longer inlined, so the RLS helpers would run once
-- per row. Wrapping them in a scalar subquery makes each an InitPlan: once per statement.
-- Same predicates as 0001 / 0005, nothing else changes.
do $$
declare
  t text;
begin
  foreach t in array array[
    'projects','articles','scripts','assets','timelines','renders',
    'channels','channel_grants','publications','brand_kits','comments','project_reviews'
  ] loop
    execute format(
      'alter policy %I on %I
         using ((select app_is_service()) or organization_id = (select app_org_id()))
         with check ((select app_is_service()) or organization_id = (select app_org_id()))',
      t || '_org_isolation', t);
  end loop;

  foreach t in array array['voice_presets','pronunciations'] loop
    execute format(
      'alter policy %I on %I
         using ((select app_is_service()) or organization_id is null or organization_id = (select app_org_id()))
         with check ((select app_is_service()) or organization_id = (select app_org_id()))',
      t || '_org_or_global', t);
  end loop;
end $$;
--> statement-breakpoint
alter policy activity_events_select on activity_events
  using ((select app_is_service()) or organization_id = (select app_org_id()) or actor_id = (select app_user_id()));
--> statement-breakpoint
alter policy usage_costs_select on usage_costs
  using ((select app_is_service()) or organization_id = (select app_org_id()) or user_id = (select app_user_id()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. RLS on the remaining tables. Better Auth and the platform settings are read and
--    written outside withOrgContext/withServiceContext (no app.* settings to test), so the
--    policy is "the app role, all rows". What RLS adds here is deny-by-default: any other
--    role that ever gets a grant on these tables (the API roles, a future read-only login)
--    sees nothing until someone writes a policy for it.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'user','session','account','verification','organization','member','invitation',
    'allowed_domains','feature_flags','integrations','music_library','prompt_templates','quotas',
    'eval_articles','prompt_evals'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_app_only', t);
    execute format('create policy %I on %I for all to ai_news_app using (true) with check (true)', t || '_app_only', t);
  end loop;
end $$;
