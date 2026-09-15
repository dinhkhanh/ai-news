ALTER TABLE "assets" ADD COLUMN "scene_id" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "selected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "attribution" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "licence_url" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "rank_reason" text;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "raw_path" text;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "render_seconds" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "timelines" ADD COLUMN "script_id" uuid;--> statement-breakpoint
ALTER TABLE "timelines" ADD COLUMN "duration_sec" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "timelines" ADD COLUMN "build_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_project_scene_idx" ON "assets" USING btree ("project_id","scene_id");