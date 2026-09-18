-- "What you hear is what you see" + political stories (2026-09-18).
-- projects.political: set by the fetch classification; the build and the editor never use stock footage or AI stills for such a story.
-- Script templates: the brollTerms rule gains `newsTerms` (per-scene news search queries naming what the voice-over mentions) in
-- every template that still carries the seeded sentence (rule 7 in v1, rule 8 in v2) – admin templates with their own wording
-- are left alone (the structured-output schema asks the model for the field either way). Source of truth: src/lib/prompts/defaults.ts.
ALTER TABLE "projects" ADD COLUMN "political" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
update prompt_templates set body = replace(
  body,
  E'brollTerms: 2 đến 4 cụm từ tìm kiếm B-roll bằng TIẾNG ANH, cụ thể và quay được (ví dụ "Ho Chi Minh City traffic aerial", "hospital corridor nurses"), tránh tên người thật.\n',
  E'brollTerms: 2 đến 4 cụm từ tìm kiếm B-roll bằng TIẾNG ANH, cụ thể và quay được (ví dụ "Ho Chi Minh City traffic aerial", "hospital corridor nurses"), tránh tên người thật.\n   newsTerms: 1 đến 3 cụm từ tìm kiếm tin tức bằng TIẾNG VIỆT nêu đúng cái mà lời bình của cảnh đó nhắc tới – tên người, cơ quan, doanh nghiệp, địa danh, sản phẩm, sự kiện (ví dụ "Thủ tướng Phạm Minh Chính", "VinFast VF 3", "cầu Nhật Tân") – để tìm được ảnh, video thật của chính họ: nghe gì thấy nấy. Để [] khi lời bình không nhắc tới ai hay cái gì cụ thể.\n'
) where purpose = 'script' and language = 'vi' and body not like '%newsTerms%';
--> statement-breakpoint
update prompt_templates set body = replace(
  body,
  E'brollTerms: 2 to 4 English stock-footage search phrases per scene, concrete and filmable (e.g. "container port cranes dusk", "doctor reviewing chart"), avoiding real people''s names.\n',
  E'brollTerms: 2 to 4 English stock-footage search phrases per scene, concrete and filmable (e.g. "container port cranes dusk", "doctor reviewing chart"), avoiding real people''s names.\n   newsTerms: 1 to 3 news search queries in English naming exactly what that scene''s voice-over mentions – the person, organisation, company, place, product or event (e.g. "Prime Minister Pham Minh Chinh", "VinFast VF 3", "Nhat Tan bridge") – so real pictures of them can be found: what you hear is what you see. [] when the voice-over names nothing specific.\n'
) where purpose = 'script' and language = 'en' and body not like '%newsTerms%';
