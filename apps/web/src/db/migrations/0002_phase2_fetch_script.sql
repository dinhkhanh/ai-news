CREATE TYPE "public"."eval_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "eval_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"language" "language" NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"text" text NOT NULL,
	"notes" text,
	"expectations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_evals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"status" "eval_status" DEFAULT 'queued' NOT NULL,
	"duration_sec" integer DEFAULT 60 NOT NULL,
	"tone" text DEFAULT 'news' NOT NULL,
	"article_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "word_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "busy_step" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "duration_sec" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tone" text DEFAULT 'news' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_articles" ADD CONSTRAINT "eval_articles_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_evals" ADD CONSTRAINT "prompt_evals_template_id_prompt_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_evals" ADD CONSTRAINT "prompt_evals_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_articles_lang_idx" ON "eval_articles" USING btree ("language","enabled");--> statement-breakpoint
CREATE INDEX "prompt_evals_template_idx" ON "prompt_evals" USING btree ("template_id","created_at");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;