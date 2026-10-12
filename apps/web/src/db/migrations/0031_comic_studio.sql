-- Comic studio (docs/COMIC.md): a story typed in becomes a short comic. Styles (platform presets with a null
-- organization_id, readable by every workspace, plus a workspace's own), reusable characters, comics with immutable
-- document versions, every generated picture (panels, character sheets, style samples) and page exports.
CREATE TABLE "comic_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"visual" text DEFAULT '' NOT NULL,
	"personality" text DEFAULT '' NOT NULL,
	"reference_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comic_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"comic_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comic_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"comic_id" uuid,
	"panel_id" text,
	"character_id" uuid,
	"style_id" uuid,
	"status" text,
	"image_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"instruction" text,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comic_styles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"negative" text DEFAULT '' NOT NULL,
	"colour_mode" text DEFAULT 'colour' NOT NULL,
	"storytelling_notes" text DEFAULT '' NOT NULL,
	"reference_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"font" text DEFAULT 'itim' NOT NULL,
	"reading_direction" text DEFAULT 'ltr' NOT NULL,
	"swatch" text DEFAULT '#e4e4e7' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comic_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"comic_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"doc" jsonb NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text,
	"story" text NOT NULL,
	"language" "language" DEFAULT 'vi' NOT NULL,
	"page_target" integer,
	"format" text DEFAULT 'a4' NOT NULL,
	"reading_direction" text DEFAULT 'ltr' NOT NULL,
	"style_id" uuid,
	"style_snapshot" jsonb NOT NULL,
	"text_model" text NOT NULL,
	"image_model" text NOT NULL,
	"audience" text DEFAULT 'general' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"current_version_id" uuid,
	"busy_step" text,
	"busy_progress" jsonb,
	"last_error" text,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_characters" ADD CONSTRAINT "comic_characters_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_exports" ADD CONSTRAINT "comic_exports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_exports" ADD CONSTRAINT "comic_exports_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_exports" ADD CONSTRAINT "comic_exports_version_id_comic_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."comic_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_exports" ADD CONSTRAINT "comic_exports_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_character_id_comic_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."comic_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_style_id_comic_styles_id_fk" FOREIGN KEY ("style_id") REFERENCES "public"."comic_styles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_styles" ADD CONSTRAINT "comic_styles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_styles" ADD CONSTRAINT "comic_styles_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_versions" ADD CONSTRAINT "comic_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_versions" ADD CONSTRAINT "comic_versions_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_versions" ADD CONSTRAINT "comic_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_style_id_comic_styles_id_fk" FOREIGN KEY ("style_id") REFERENCES "public"."comic_styles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comic_characters_org_idx" ON "comic_characters" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "comic_exports_comic_idx" ON "comic_exports" USING btree ("comic_id","created_at");--> statement-breakpoint
CREATE INDEX "comic_images_comic_idx" ON "comic_images" USING btree ("comic_id","panel_id");--> statement-breakpoint
CREATE INDEX "comic_images_sheet_idx" ON "comic_images" USING btree ("character_id","style_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comic_images_one_accepted_sheet_idx" ON "comic_images" USING btree ("character_id","style_id") WHERE "comic_images"."kind" = 'sheet' and "comic_images"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "comic_styles_org_idx" ON "comic_styles" USING btree ("organization_id","position");--> statement-breakpoint
CREATE INDEX "comic_versions_comic_idx" ON "comic_versions" USING btree ("comic_id","created_at");--> statement-breakpoint
CREATE INDEX "comics_org_idx" ON "comics" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "comic_styles" ADD CONSTRAINT "comic_styles_colour_mode_check" CHECK ("colour_mode" in ('colour', 'bw'));--> statement-breakpoint
ALTER TABLE "comic_styles" ADD CONSTRAINT "comic_styles_reading_direction_check" CHECK ("reading_direction" in ('ltr', 'rtl'));--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_reading_direction_check" CHECK ("reading_direction" in ('ltr', 'rtl'));--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_state_check" CHECK ("state" in ('created', 'adapted', 'script_approved', 'drawing', 'drawn', 'exported'));--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_audience_check" CHECK ("audience" in ('kids', 'general', 'adult'));--> statement-breakpoint
ALTER TABLE "comics" ADD CONSTRAINT "comics_page_target_check" CHECK ("page_target" IS NULL OR "page_target" BETWEEN 1 AND 40);--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_kind_check" CHECK ("kind" in ('panel', 'sheet', 'sample'));--> statement-breakpoint
ALTER TABLE "comic_images" ADD CONSTRAINT "comic_images_status_check" CHECK (("kind" = 'sheet') = ("status" IS NOT NULL) AND ("status" IS NULL OR "status" in ('draft', 'accepted')));--> statement-breakpoint
ALTER TABLE "comic_versions" ADD CONSTRAINT "comic_versions_kind_check" CHECK ("kind" in ('adapt', 'edit', 'draw', 'letter'));--> statement-breakpoint
ALTER TABLE "comic_exports" ADD CONSTRAINT "comic_exports_kind_check" CHECK ("kind" in ('png', 'pdf', 'webtoon', 'zip'));--> statement-breakpoint
ALTER TABLE "comic_exports" ADD CONSTRAINT "comic_exports_status_check" CHECK ("status" in ('queued', 'rendering', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "comic_styles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY comic_styles_org_isolation ON comic_styles FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id is null or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
ALTER TABLE "comic_characters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY comic_characters_org_isolation ON comic_characters FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
ALTER TABLE "comics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY comics_org_isolation ON comics FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
ALTER TABLE "comic_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY comic_versions_org_isolation ON comic_versions FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
ALTER TABLE "comic_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY comic_images_org_isolation ON comic_images FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
ALTER TABLE "comic_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY comic_exports_org_isolation ON comic_exports FOR ALL TO ai_news_app
  USING ((select app_is_service()) or organization_id = (select app_org_id()))
  WITH CHECK ((select app_is_service()) or organization_id = (select app_org_id()));--> statement-breakpoint
-- Platform style presets (docs/COMIC.md §6). Art direction names techniques, never artists or franchises.
INSERT INTO "comic_styles" ("organization_id", "name", "prompt", "negative", "colour_mode", "storytelling_notes", "font", "reading_direction", "swatch", "position") VALUES
  (NULL, 'Manga đen trắng', 'Japanese manga page art: crisp black ink line art with varied line weight, screentone dot shading, speed lines for motion, expressive eyes, dramatic angles', 'colour, grey wash, photorealism, 3D render', 'bw', 'More silent panels and reaction close-ups; speed lines for action; a page often ends on a hook.', 'itim', 'rtl', 'radial-gradient(#18181b 1.2px, #ffffff 1.4px) 0 0 / 7px 7px', 10),
  (NULL, 'Webtoon màu', 'Korean webtoon digital illustration: clean thin line art, soft cel shading, gentle gradients, bright pastel palette, appealing modern character design', 'photorealism, heavy texture, gritty', 'colour', 'Vertical pacing: one beat per panel, generous close-ups of faces, short lines.', 'itim', 'ltr', 'linear-gradient(135deg, #fbd1c4 0 50%, #bfd7f6 50% 100%)', 20),
  (NULL, 'Truyện tranh Mỹ', 'Classic American comic book art: bold black inks, dynamic anatomy, flat saturated colours with halftone dots, strong shadows, cinematic angles', 'photorealism, anime style, pastel', 'colour', 'Dense pages, dynamic action shots, captions carry narration.', 'bevietnam', 'ltr', 'linear-gradient(90deg, #c8102e 0 33%, #f2c230 33% 66%, #1f3a93 66% 100%)', 30),
  (NULL, 'Ligne claire', 'European ligne claire comic art: uniform clear outlines of constant weight, flat bright colours without hatching, detailed realistic backgrounds, simplified expressive characters', 'hatching, heavy shadows, gradients, photorealism', 'colour', 'Even grid pages, clear staging, establishing shots for every new place.', 'bevietnam', 'ltr', 'linear-gradient(180deg, #9cc9e8 0 55%, #e9d7a6 55% 100%)', 40),
  (NULL, 'Sách tranh màu nước', 'Children''s picture book illustration: soft watercolour washes on textured paper, loose pencil lines, warm gentle palette, rounded friendly shapes', 'harsh shadows, scary imagery, photorealism, dark palette', 'colour', 'Few panels per page, big friendly images, short simple lines.', 'itim', 'ltr', 'radial-gradient(circle at 30% 40%, #f6c9a8 0 30%, transparent 31%), radial-gradient(circle at 70% 65%, #b9dcc8 0 32%, transparent 33%), #fbf7ef', 50),
  (NULL, 'Noir', 'Film noir comic art: high-contrast black and white, deep shadows and silhouettes, chiaroscuro lighting, rain and city at night, venetian blind light patterns', 'colour, bright cheerful lighting, cartoonish', 'bw', 'Moody captions in first person, long shadows, slow reveals.', 'bevietnam', 'ltr', 'linear-gradient(115deg, #0e0e10 0 58%, #e7e5e4 58% 64%, #0e0e10 64% 100%)', 60),
  (NULL, 'Chibi', 'Cute chibi comic art: characters with big heads and small bodies, huge sparkling eyes, simple rounded shapes, bright candy colours, playful expressions', 'realistic proportions, dark themes, photorealism', 'colour', 'Comedic timing: setup, reaction, punchline; exaggerated expressions.', 'itim', 'ltr', 'radial-gradient(circle at 50% 55%, #ffd6e2 0 34%, #fff2b8 35% 100%)', 70),
  (NULL, 'Tranh dân gian', 'Vietnamese folk woodblock print style: bold flat shapes, thick dark outlines, limited earthy palette of red, ochre, green and black on warm dó paper texture, decorative stylised patterns', 'photorealism, gradients, 3D render, modern clothing', 'colour', 'Storybook pacing, symmetrical compositions, narration in captions.', 'bevietnam', 'ltr', 'linear-gradient(90deg, #b83a2e 0 25%, #e7b23a 25% 50%, #2f6b4f 50% 75%, #1c1c1c 75% 100%)', 80);
