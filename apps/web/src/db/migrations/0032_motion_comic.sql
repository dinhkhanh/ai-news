-- Motion comic (docs/COMIC.md §11.1, M4): a comic of the studio becomes a 9:16 video project (`source_kind = 'comic'`,
-- no link) that keeps the comic and the frozen version it was made from; comic characters get a voice of their own.
ALTER TABLE "comic_characters" ADD COLUMN "voice_preset_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "comic_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "comic_version_id" uuid;--> statement-breakpoint
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_voice_preset_id_voice_presets_id_fk" FOREIGN KEY ("voice_preset_id") REFERENCES "public"."voice_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_comic_version_id_comic_versions_id_fk" FOREIGN KEY ("comic_version_id") REFERENCES "public"."comic_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_comic_idx" ON "projects" USING btree ("comic_id");--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_source_kind_check";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_kind_check" CHECK ("source_kind" in ('article', 'video', 'text', 'topic', 'comic'));--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_url_check";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_url_check" CHECK ("source_kind" in ('text', 'topic', 'comic') OR "url" IS NOT NULL);
