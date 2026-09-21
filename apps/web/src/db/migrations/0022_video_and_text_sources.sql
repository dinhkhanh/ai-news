-- Projects from a video page (`video`: the file is the footage, the user writes the content) and from content typed in
-- at creation (`text`: no link, so `url` / `articles.canonical_url` become nullable for that kind only).
ALTER TABLE "articles" ALTER COLUMN "canonical_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_kind" text DEFAULT 'article' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_video_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_video_asset_id_assets_id_fk" FOREIGN KEY ("source_video_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_kind_check" CHECK ("source_kind" in ('article', 'video', 'text'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_url_check" CHECK ("source_kind" = 'text' OR "url" IS NOT NULL);
