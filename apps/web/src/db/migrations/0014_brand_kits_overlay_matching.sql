-- Several named brand kits per workspace: a full-frame overlay PNG per kit, what the kit is for (description +
-- keywords, used to match a kit to an article), and the kit chosen for a project.
-- (The generated snapshot also catches up with projects.busy_progress from 0009, which never had one.)
ALTER TABLE "brand_kits" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "match_keywords" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "auto_match" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "overlay_path" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "overlay_layer" text DEFAULT 'under_text' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brand_kit_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brand_kit_source" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brand_kit_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_brand_kit_id_brand_kits_id_fk" FOREIGN KEY ("brand_kit_id") REFERENCES "public"."brand_kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A workspace has at most one default kit; keep the oldest if an earlier bug left several.
UPDATE "brand_kits" b SET "is_default" = false WHERE b."is_default" AND b."id" <> (SELECT d."id" FROM "brand_kits" d WHERE d."organization_id" = b."organization_id" AND d."is_default" ORDER BY d."created_at", d."id" LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX "brand_kits_one_default_idx" ON "brand_kits" USING btree ("organization_id") WHERE "brand_kits"."is_default";