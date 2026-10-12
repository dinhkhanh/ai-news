-- Editor plugins a workspace switched off (components/editor/plugins): one row per workspace, written by its
-- admins from the editor's "Tiện ích" panel. No row = every built-in plugin on. Org-scoped like brand_kits.
CREATE TABLE "editor_plugin_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"disabled" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "editor_plugin_settings" ADD CONSTRAINT "editor_plugin_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editor_plugin_settings" ADD CONSTRAINT "editor_plugin_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "editor_plugin_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY editor_plugin_settings_org_isolation ON editor_plugin_settings FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));
