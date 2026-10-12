-- Topic projects (`source_kind = 'topic'`): the user gives keywords, a topic or directions (`brief`) instead of a link;
-- the fetch step researches it on the web and stores the article with the pages it is based on (`articles.sources`).
ALTER TABLE "articles" ADD COLUMN "sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_source_kind_check";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_kind_check" CHECK ("source_kind" in ('article', 'video', 'text', 'topic'));--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_url_check";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_url_check" CHECK ("source_kind" in ('text', 'topic') OR "url" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_brief_check" CHECK ("source_kind" <> 'topic' OR length(btrim(coalesce("brief", ''))) > 0);
