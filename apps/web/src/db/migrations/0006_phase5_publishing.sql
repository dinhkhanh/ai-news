ALTER TYPE "public"."publication_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "platform" "platform" NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "platform_url" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "privacy" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "ai_disclosure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "publications_project_idx" ON "publications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "publications_org_created_idx" ON "publications" USING btree ("organization_id","created_at");