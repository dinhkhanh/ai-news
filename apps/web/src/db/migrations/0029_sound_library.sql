-- Sound collections (/app/sounds): members collect sounds from the public library (Openverse), Pixabay Music
-- imports and their own files. Org-scoped like brand_kits; private collections are filtered in the app.
CREATE TABLE "sound_collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"creator" text,
	"creator_url" text,
	"landing_url" text,
	"licence" text NOT NULL,
	"licence_version" text,
	"licence_url" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"duration_sec" numeric(8, 2),
	"r2_path" text NOT NULL,
	"mime" text,
	"size_bytes" bigint,
	"position" integer DEFAULT 0 NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sound_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"shared" boolean DEFAULT true NOT NULL,
	"colour" text DEFAULT '#2563eb' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sound_collection_items" ADD CONSTRAINT "sound_collection_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_collection_items" ADD CONSTRAINT "sound_collection_items_collection_id_sound_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."sound_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_collection_items" ADD CONSTRAINT "sound_collection_items_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_collections" ADD CONSTRAINT "sound_collections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sound_collections" ADD CONSTRAINT "sound_collections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sound_collection_items_collection_idx" ON "sound_collection_items" USING btree ("collection_id","position");--> statement-breakpoint
CREATE INDEX "sound_collection_items_org_provider_idx" ON "sound_collection_items" USING btree ("organization_id","provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sound_collection_items_unique_idx" ON "sound_collection_items" USING btree ("collection_id","provider","provider_id");--> statement-breakpoint
CREATE INDEX "sound_collections_org_idx" ON "sound_collections" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "sound_collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sound_collections_org_isolation ON sound_collections FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
ALTER TABLE "sound_collection_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sound_collection_items_org_isolation ON sound_collection_items FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));
