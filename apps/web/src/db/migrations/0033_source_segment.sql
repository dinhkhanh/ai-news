-- Video projects: the part of the source video to download and use, chosen before the download; null = from the
-- start / to the end. At most 10 min (`SOURCE_VIDEO_MAX_SEC`), the end after the start.
ALTER TABLE "projects" ADD COLUMN "source_start_sec" numeric(8, 1);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_end_sec" numeric(8, 1);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_segment_check" CHECK (
  ("source_start_sec" IS NULL OR "source_start_sec" >= 0)
  AND ("source_end_sec" IS NULL OR "source_end_sec" > coalesce("source_start_sec", 0))
  AND ("source_end_sec" IS NULL OR "source_end_sec" - coalesce("source_start_sec", 0) <= 600)
);
