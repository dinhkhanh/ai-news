-- Hand-drawn photos (video 0.16.0): the style the build gives every downloaded photo (`pencil` | `ink` | `colour`),
-- each such shot opening on the photo and turning into a drawing of it, or `off`.
ALTER TABLE "projects" ADD COLUMN "photo_sketch" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_photo_sketch_check" CHECK ("photo_sketch" in ('off', 'pencil', 'ink', 'colour'));
