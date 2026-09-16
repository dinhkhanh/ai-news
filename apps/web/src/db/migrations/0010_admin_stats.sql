-- Admin overview (src/app/admin/page.tsx): one round-trip instead of seven parallel
-- queries. Total counts are exact; the 30-day windows use the created_at indexes.
-- SECURITY DEFINER so it returns platform-wide aggregates regardless of the RLS
-- context of the caller — it only exposes counts and sums, never rows.
create or replace function admin_overview_stats(since timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with spend as (
    select provider, sum(cost_usd) as usd
    from usage_costs
    where created_at >= since
    group by provider
  )
  select jsonb_build_object(
    'users',    (select count(*) from "user"),
    'orgs',     (select count(*) from organization),
    'projects', (select count(*) from projects),
    'renders',  (select count(*) from renders),
    'events',   (select count(*) from activity_events where created_at >= since),
    'spendUsd', (select coalesce(sum(usd), 0) from spend),
    'byProvider', (
      select coalesce(jsonb_agg(jsonb_build_object('provider', provider, 'usd', usd) order by usd desc), '[]'::jsonb)
      from spend
    )
  )
$$;
--> statement-breakpoint
revoke all on function admin_overview_stats(timestamptz) from public;
--> statement-breakpoint
grant execute on function admin_overview_stats(timestamptz) to ai_news_app;
