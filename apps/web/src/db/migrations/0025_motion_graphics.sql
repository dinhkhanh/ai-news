-- Motion graphics (Claude Opus 5.5 + Remotion / HyperFrames, video 0.15.0): per project, which scenes the build turns
-- into motion graphics (`off` | `auto` = Claude picks | `all` = every scene) and with which engine.
ALTER TABLE "projects" ADD COLUMN "motion_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "motion_engine" text DEFAULT 'remotion' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_motion_mode_check" CHECK ("motion_mode" in ('off', 'auto', 'all'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_motion_engine_check" CHECK ("motion_engine" in ('remotion', 'hyperframes'));
