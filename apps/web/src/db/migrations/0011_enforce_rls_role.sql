-- Defense in depth for workspace isolation. The RLS policies (0001) apply to the
-- ai_news_app role only; a DATABASE_URL using the postgres owner role bypasses
-- them and every member sees every workspace. src/db/context.ts now switches
-- every org/service transaction to ai_news_app (set_config('role', ...)), so
-- the login role needs membership in it.
do $$
begin
  if current_user <> 'ai_news_app' then
    execute format('grant ai_news_app to %I', current_user);
  end if;
end $$;
