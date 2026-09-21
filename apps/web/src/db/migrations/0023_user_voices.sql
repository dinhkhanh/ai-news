-- Workspace voices anyone who can edit creates at /app/voices: a Gemini-TTS voice (`model`) with style instructions
-- (`prompt`: tone, pace…), chosen per project (`projects.voice_preset_id`, null = the workspace default for the language).
ALTER TABLE "projects" ADD COLUMN "voice_preset_id" uuid;--> statement-breakpoint
ALTER TABLE "voice_presets" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "voice_presets" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "voice_presets" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "voice_presets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_voice_preset_id_voice_presets_id_fk" FOREIGN KEY ("voice_preset_id") REFERENCES "public"."voice_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_presets" ADD CONSTRAINT "voice_presets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_presets_one_default_idx" ON "voice_presets" USING btree ("organization_id","language") WHERE "voice_presets"."is_default";