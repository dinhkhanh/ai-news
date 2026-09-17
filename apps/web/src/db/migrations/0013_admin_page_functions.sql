-- Admin CMS pages: one round-trip per page (same idea as admin_overview_stats in 0010).
-- The tables are small; what made these pages slow was the number of round-trips to the
-- pooler: every withServiceContext() read costs four (begin, set_config, query, commit),
-- several pages ran their queries one after another, and the integrations page decrypted
-- one Vault secret per query. Each function below returns everything its page needs as
-- one jsonb document with camelCase keys (src/lib/admin-data.ts types and revives it).
-- SECURITY DEFINER so they read across workspaces without the service-context
-- transaction; execute is granted to the app role only.

create or replace function admin_analytics_stats(since timestamptz, day_start timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with pub as (
    select p.id, p.platform, p.platform_url, p.project_id, p.published_at,
           (p.analytics_json->>'views')::numeric    as views,
           (p.analytics_json->>'likes')::numeric    as likes,
           (p.analytics_json->>'comments')::numeric as comments,
           (p.analytics_json->>'shares')::numeric   as shares
    from publications p
    where p.status = 'published' and p.published_at >= since
  )
  select jsonb_build_object(
    'produced',  (select count(*) from renders where status = 'done' and created_at >= since),
    'published', (select count(*) from pub),
    'byPlatform', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.posts desc), '[]'::jsonb)
      from (
        select platform, count(*) as posts, coalesce(sum(views), 0) as views, coalesce(sum(likes), 0) as likes,
               coalesce(sum(comments), 0) as comments, coalesce(sum(shares), 0) as shares
        from pub group by platform
      ) x
    ),
    'byDay', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.day desc), '[]'::jsonb)
      from (
        select to_char(published_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as day, count(*) as posts, coalesce(sum(views), 0) as views
        from pub group by 1 order by 1 desc limit 30
      ) x
    ),
    'byStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) as n from publications where created_at >= since group by status) x
    ),
    'ytUnitsToday', (select coalesce(sum(units), 0) from usage_costs where provider = 'youtube_api' and created_at >= day_start),
    'topPosts', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.views desc nulls last), '[]'::jsonb)
      from (
        select pub.id, pub.platform, pub.platform_url as url, pr.title, pub.views
        from pub left join projects pr on pr.id = pub.project_id
        order by pub.views desc nulls last limit 10
      ) x
    ),
    'channels',          (select count(*) from channels),
    'unhealthyChannels', (select count(*) from channels where not healthy)
  )
$$;
--> statement-breakpoint
create or replace function admin_members_json() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organizationId', m.organization_id, 'userId', m.user_id, 'role', m.role, 'email', u.email, 'name', u.name
  ) order by u.email), '[]'::jsonb)
  from member m join "user" u on u.id = m.user_id
$$;
--> statement-breakpoint
create or replace function admin_channels_page() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'orgs', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind) order by name), '[]'::jsonb) from organization),
    'channels', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'organizationId', organization_id, 'platform', platform, 'externalId', external_id, 'name', name,
        'avatarUrl', avatar_url, 'hasToken', vault_ref is not null, 'scopes', to_jsonb(scopes), 'expiresAt', expires_at,
        'healthy', healthy, 'lastError', last_error, 'lastCheckedAt', last_checked_at, 'enabled', enabled
      ) order by platform, name), '[]'::jsonb)
      from channels
    ),
    'members', admin_members_json(),
    'grants', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'channelId', channel_id, 'userId', user_id)), '[]'::jsonb) from channel_grants),
    'metaReady',   exists (select 1 from integrations where provider = 'meta_app' and enabled and vault_ref is not null),
    'tiktokReady', exists (select 1 from integrations where provider = 'tiktok_app' and enabled and vault_ref is not null),
    'flags', (select coalesce(jsonb_object_agg(key, enabled), '{}'::jsonb) from feature_flags)
  )
$$;
--> statement-breakpoint
create or replace function admin_workspaces_page() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'orgs', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind) order by created_at), '[]'::jsonb) from organization),
    'members', admin_members_json(),
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'email', email) order by email), '[]'::jsonb) from "user")
  )
$$;
--> statement-breakpoint
create or replace function admin_quotas_page() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'quotas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'scope', scope, 'scopeId', scope_id, 'resource', resource, 'dailyLimit', daily_limit
      ) order by scope, scope_id, resource), '[]'::jsonb)
      from quotas
    ),
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'email', email) order by email), '[]'::jsonb) from "user"),
    'orgs',  (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from organization)
  )
$$;
--> statement-breakpoint
-- Secrets are masked inside the database (same rule as maskSecret in src/lib/vault.ts), so the
-- page no longer pulls every decrypted key into the app just to show four characters of it.
-- plpgsql + dynamic SQL: the vault schema does not exist on a local Postgres / PGlite.
create or replace function admin_integrations_page() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  previews jsonb := '{}'::jsonb;
  vault_ok boolean := true;
begin
  begin
    execute $q$
      select coalesce(jsonb_object_agg(i.provider, case
        when s.decrypted_secret is null or s.decrypted_secret = '' then ''
        when length(s.decrypted_secret) <= 8 then '••••'
        else left(s.decrypted_secret, 4) || '…' || right(s.decrypted_secret, 4) end), '{}'::jsonb)
      from integrations i join vault.decrypted_secrets s on s.id = i.vault_ref
    $q$ into previews;
  exception when others then
    vault_ok := false;
  end;
  return jsonb_build_object(
    'integrations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'provider', i.provider, 'hasSecret', i.vault_ref is not null, 'enabled', i.enabled,
        'spendCapMonthlyUsd', i.spend_cap_monthly_usd::text, 'creditsRemaining', i.credits_remaining, 'updatedAt', i.updated_at,
        'preview', case when i.vault_ref is null then null when not vault_ok then '(vault read failed)' else coalesce(previews->>i.provider, '') end
      )), '[]'::jsonb)
      from integrations i
    ),
    'flags', (select coalesce(jsonb_object_agg(key, enabled), '{}'::jsonb) from feature_flags)
  );
end $$;
--> statement-breakpoint
-- Eval page: the article text is only needed for its word count, and `results` (one entry per
-- article, per run) only for the run on screen: `run` when it is one of the latest 30, else the newest.
create or replace function admin_evals_page(run uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with runs as (
    select e.id, e.status, e.duration_sec, e.tone, e.article_count, e.summary, e.cost_usd, e.error, e.created_at, e.finished_at,
           t.purpose, t.language, t.version, t.id as template_id
    from prompt_evals e join prompt_templates t on t.id = e.template_id
    order by e.created_at desc limit 30
  ), active as (
    select id from runs order by (id = run) desc nulls last, created_at desc limit 1
  )
  select jsonb_build_object(
    'articles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'language', language, 'title', title, 'sourceUrl', source_url, 'notes', notes, 'expectations', expectations,
        'enabled', enabled, 'words', coalesce(array_length(regexp_split_to_array(btrim(text), '\s+'), 1), 0)
      ) order by created_at desc), '[]'::jsonb)
      from eval_articles
    ),
    'runs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'status', status, 'durationSec', duration_sec, 'tone', tone, 'articleCount', article_count, 'summary', summary,
        'costUsd', cost_usd::text, 'error', error, 'createdAt', created_at, 'finishedAt', finished_at,
        'purpose', purpose, 'language', language, 'version', version, 'templateId', template_id
      ) order by created_at desc), '[]'::jsonb)
      from runs
    ),
    'activeId', (select id from active),
    'activeResults', (select coalesce(e.results, '[]'::jsonb) from prompt_evals e where e.id = (select id from active)),
    'recentProjects', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
      from (select id, title, url, language, state, created_at from projects where state = 'scripted' order by created_at desc limit 15) x
    )
  )
$$;
--> statement-breakpoint
create or replace function admin_recent_renders(max_rows int) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'createdAt', created_at, 'status', status, 'durationSec', duration_sec::text, 'costUsd', cost_usd::text,
    'qaJson', qa_json, 'outputPath', output_path, 'error', error
  ) order by created_at desc), '[]'::jsonb)
  from (select * from renders order by created_at desc limit greatest(1, least(max_rows, 200))) r
$$;
--> statement-breakpoint
create or replace function admin_activity_page(type_prefix text, actor text, max_rows int, skip_rows int) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'type', type, 'actorEmail', actor_email, 'impersonatorId', impersonator_id, 'organizationId', organization_id,
    'projectId', project_id, 'payload', payload, 'ip', ip, 'createdAt', created_at
  ) order by id desc), '[]'::jsonb)
  from (
    select a.id, a.type, u.email as actor_email, a.impersonator_id, a.organization_id, a.project_id, a.payload, a.ip, a.created_at
    from activity_events a left join "user" u on u.id = a.actor_id
    where (type_prefix is null or a.type ilike type_prefix || '%') and (actor is null or a.actor_id = actor)
    order by a.id desc
    limit greatest(1, least(max_rows, 500)) offset greatest(0, skip_rows)
  ) x
$$;
--> statement-breakpoint
-- Supabase's default privileges grant EXECUTE on every new public function to anon /
-- authenticated / service_role, which would publish these SECURITY DEFINER functions on the
-- REST API (/rest/v1/rpc/...) for anyone holding the anon key. `revoke ... from public` does not
-- undo those grants, so revoke them by name. admin_overview_stats (0010) had the same hole.
do $$
declare
  f text;
  r text;
begin
  foreach f in array array[
    'admin_overview_stats(timestamptz)',
    'admin_analytics_stats(timestamptz, timestamptz)', 'admin_members_json()', 'admin_channels_page()', 'admin_workspaces_page()',
    'admin_quotas_page()', 'admin_integrations_page()', 'admin_evals_page(uuid)', 'admin_recent_renders(int)',
    'admin_activity_page(text, text, int, int)'
  ] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
    execute format('grant execute on function %s to ai_news_app', f);
  end loop;
end $$;
