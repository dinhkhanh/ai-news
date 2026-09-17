-- The brand kit is shared by every social channel; the logo is the channel's. Projects choose whose logo
-- their videos carry, a render can pick another channel, and the render keeps a record of what it drew.
ALTER TABLE "channels" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "logo_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "logo_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_logo_channel_id_channels_id_fk" FOREIGN KEY ("logo_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_logo_channel_id_channels_id_fk" FOREIGN KEY ("logo_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- /admin/channels shows and uploads the logo: same function as 0013 plus 'logoPath' (signature unchanged, grants kept).
create or replace function admin_channels_page() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'orgs', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind) order by name), '[]'::jsonb) from organization),
    'channels', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'organizationId', organization_id, 'platform', platform, 'externalId', external_id, 'name', name,
        'avatarUrl', avatar_url, 'logoPath', logo_path, 'hasToken', vault_ref is not null, 'scopes', to_jsonb(scopes), 'expiresAt', expires_at,
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
