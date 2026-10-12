# Comic studio: design

Status: **draft for review**, nothing implemented. Written 2026-10-12.

A standalone feature: a member pastes a story (plain text), picks or defines a style, a cast and the AI models,
and the app produces a short comic, 5–10 pages by default or as many as asked. It shares the app's infrastructure
(auth, workspaces, Claude client, Vertex image generation, R2, Inngest, cost and activity rows, Remotion Lambda)
but none of the news pipeline: no article, no timeline, no publishing.

Open questions that change the build are at the end (§13), each with a recommendation.

---

## 1. Goals and non-goals

**Goals**

- Story text in, finished comic out: page images (PNG), a PDF and a vertical webtoon strip.
- The member controls: page count, page format, reading direction, art style, characters (looks and voice),
  the text model that writes the adaptation and the image model that draws, the language of the lettering.
- Characters look the same from panel to panel and page to page.
- Cheap iteration before money is spent: the script (page and panel breakdown, dialogue) is reviewed and edited
  before any image is drawn, and a cost estimate is shown before drawing.
- Any panel can be redrawn alone, with an instruction; any balloon can be edited, moved or deleted.
- Vietnamese and English lettering with correct diacritics.

**Non-goals (v1)**

- Publishing a comic itself to social channels. Comics reach the channels as motion comics: a 9:16 video project made
  from the comic, which goes through the normal review / render / publish flow (M4, §11.1).
- Multi-user real-time co-editing.
- Training or fine-tuning a model per character (LoRA). Consistency comes from reference images (§6).
- Image models the app cannot reach today without a new contract (only Vertex Gemini in v1, §5).

---

## 2. User flow

```
 ┌───────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────┐   ┌──────────┐
 │ 1. Story  │ → │ 2. Adapt     │ → │ 3. Review     │ → │ 4. Cast      │ → │ 5. Draw   │ → │ 6. Edit  │ → Export
 │ + options │   │ (Claude)     │   │ script (free) │   │ sheets       │   │ panels    │   │ + letter │
 └───────────┘   └──────────────┘   └───────────────┘   └──────────────┘   └───────────┘   └──────────┘
   text, style,    pages → panels,    edit / reorder /    one reference      per panel,      balloons,
   cast, models,   dialogue, cast     add / cut panels,   sheet per char.    refs = sheets   redraw,
   page count      proposal, setting  approve → estimate  per style          + style + prev  layout
```

1. **New comic** (`/app/comics/new`): story text (≤ 40 000 chars, or upload a .txt / .md / .docx), title (optional,
   Claude proposes one), language of the lettering, page count (`Tự động 5–10` or an exact number 1–40),
   format, reading direction, style, cast (pick saved characters; unknown ones are proposed in step 2),
   audience / tone (`thiếu nhi`, `phổ thông`, `người lớn`), dialogue density, text model, image model.
   Every option has a workspace default so "paste + Tạo" works.
2. **Adapt** (Claude, ~30–90 s): a structured script (§4). New characters found in the story come back as
   proposed cast members with a visual description; the member keeps, merges or drops them.
3. **Review script**: a page-by-page outline editor. Edit any field, move panels between pages, add / delete
   panels or pages, "Viết lại trang này" with an instruction (Claude again, one page). Nothing has been drawn yet,
   so this is where the story is fixed. The approve button shows the estimate: `42 khung × $0.067 ≈ $2.81`.
4. **Cast sheets**: each character without a sheet in the chosen style gets one (front / three-quarter / profile +
   expression row on one image). The member accepts, redraws with an instruction, or uploads their own drawing.
   Sheets are cached per (character, style), so the second comic with the same cast skips this step.
5. **Draw**: panels are drawn in parallel (bounded concurrency), pages fill in live. Lettering is laid out
   automatically as soon as a panel exists.
6. **Edit**: page view; select a panel to redraw (instruction, keep composition / new composition), pick among
   its variants, crop / pan inside the frame; select a balloon to edit text, style (speech, thought, shout,
   whisper, caption, SFX), position and tail; change a page's layout template.
7. **Export**: PNG per page, PDF, webtoon strip (single column, 800 px wide, split into ≤ 8 000 px tall files),
   a zip of everything. Exports are immutable files under `renders/comics/…`.

---

## 3. Architecture

```
 /app/comics/*  (Next.js pages + server actions)
        │  comic/<event>.requested
        ▼
 Inngest: comic-adapt ──► comic-cast ──► comic-draw (fan-out per panel) ──► comic-letter
                                                                          comic-export (on demand)
        │                        │                         │                     │
   Claude (MODELS /         Image model adapter       Cloud Vision faces     Remotion Lambda
   member's pick)           (Vertex Gemini v1)        (balloon placement)    renderStill ComicPage
        │                        │                         │                     │
        └────────────── usage_costs, activity_events, R2 (media/<org>/comics/<comic>/…) ───────────┘
```

New code, all under `apps/web/src/lib/comic/` (server) and `packages/video/src/compositions/ComicPage.tsx`:

| Module | Kind | Role |
|---|---|---|
| `comic/schema.ts` | pure, tested | Zod schemas: comic document (§7), script output, layout, lettering. Shared with the browser and the composition via `@ai-news/video/comic`. |
| `comic/models.ts` | pure, tested | Text and image model catalogue (§5): ids, labels, prices, capabilities, `estimateCost`. |
| `comic/layout.ts` | pure, tested | Page templates, panel rectangles for a page format, aspect-ratio snapping to what the image model supports, gutters / bleed. |
| `comic/lettering.ts` | pure, tested | Balloon sizing (text measurement table per font), auto placement avoiding faces and other balloons, reading order, tail geometry. |
| `comic/prompts.ts` | pure, tested | Builds the image prompt for a panel / sheet from style + characters + panel fields; builds the adaptation request. |
| `comic/adapt.ts` | server | Claude call: story → script (structured output). |
| `comic/images.ts` | server | `ImageModel` adapters (`generate({ prompt, refs, aspect, size })`), Vertex Gemini first; meters cost + quota. |
| `comic/service.ts` | server | Version saves, busy flags, cost totals, access checks. |
| `inngest/functions/comic-*.ts` | server | The durable steps. |
| `ComicPage.tsx` | composition | Draws one page (panels, borders, balloons, SFX) from the document. Same component in the browser reader / editor and in `renderStillOnLambda` for exports. |

Why render pages with Remotion and not let the browser export: the export must look exactly like the editor, use the
same verified Vietnamese fonts (Be Vietnam Pro, Noto Sans) and not depend on the member's machine. Remotion Lambda
is already deployed; `renderStillOnLambda` renders one page in a few seconds. PDF assembly (pdf-lib) and the
webtoon strip (sharp) run in an Inngest step on Vercel.

---

## 4. Adaptation (story → script)

One Claude call with structured output (`client.beta.messages.parse`, adaptive thinking, effort `high`, cached
system block, `fallbacks: "default"`, same conventions as `llm/script.ts`). Input: the story, the options, the
chosen cast with their descriptions, the style's "storytelling notes" (e.g. manga = more silent panels, bigger
reaction shots). Output:

```ts
Script = {
  title: string,
  logline: string,
  cast: { ref: string /* existing character id or "new:<slug>" */, name, role, visual: string /* English, for prompts */, personality }[],
  settings: { id, name, visual: string }[],          // recurring places, reused as continuity anchors
  pages: {
    number, beat: string,                              // what this page does for the story
    layoutHint: "splash" | "grid" | "wide-top" | "tall-left" | "auto",
    panels: {
      id, size: "small" | "medium" | "large" | "wide" | "tall",
      shot: "establishing" | "wide" | "medium" | "close-up" | "extreme close-up" | "over-the-shoulder" | "bird's-eye" | "worm's-eye",
      settingId, time: "day" | "night" | "dusk" | …, mood,
      characters: { ref, position: "left" | "center" | "right" | "background", action, expression }[],
      description: string,                             // English: what the picture shows (no text in it)
      lettering: { kind: "speech" | "thought" | "shout" | "whisper" | "caption" | "sfx", speaker?: ref, text: string /* lettering language */ }[],
    }[],
  }[],
}
```

Rules in the prompt: respect the page count (auto = 5–10 chosen from story length), 3–6 panels per page (style
can override), ≤ 25 words per balloon and ≤ 3 balloons per panel, the first page establishes the setting and the
protagonist, the last panel lands the ending, no new plot facts beyond the story unless the member asked for
"phóng tác tự do" (free adaptation, an option). `description` / `visual` are English because the image models
follow English best; `lettering.text` is in the comic's language. A long story is condensed, not truncated:
the whole text is sent (Opus 5.5 has 1M context; the 40 000-char cap keeps cost bounded).

Re-adapting one page ("Viết lại trang này") sends the full script plus the instruction and replaces that page only.

---

## 5. Model choice

The member picks two models per comic; workspace defaults in `/app/comics/settings`. Catalogue in `comic/models.ts`:

**Text (adaptation)**, Anthropic client from `llm/client.ts` (Vault key, spend cap):

| Label | Id | $/MTok in / out | Note |
|---|---|---|---|
| Claude Opus 5.5 (mặc định) | `claude-opus-5-5` | 4 / 20 | Best structure and dialogue. ~$0.10–0.30 per comic. |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2 / 10 | Faster, half the price. |
| Claude Haiku 5.5 | `claude-haiku-5-5` | 0.10 / 0.50 | Drafts only. |

`PRICING` in `llm/client.ts` gains the two missing rows.

**Image (drawing)**, behind one adapter interface so a provider is one file:

| Label | Id | ~$/image | Refs | v1? |
|---|---|---|---|---|
| Gemini 3.1 Flash Image (mặc định) | `gemini-3.1-flash-image` | 0.067 (1K) | several | yes, already used by `media/generate.ts` |
| Gemini 3 Pro Image | `gemini-3-pro-image` | 0.134 (1K/2K), 0.24 (4K) | more, best consistency | yes, same Vertex auth |
| GPT Image 2 (OpenAI) | `gpt-image-2` | ~0.03–0.08 | up to 16 | phase 3, needs an `openai` integration |
| FLUX Kontext / others | — | — | — | later, via the same adapter |

Exact ids, reference-image limits, supported aspect ratios and prices are verified against the provider docs at
implementation time (third-party pricing pages disagree; the table is indicative). Each catalogue entry carries
`aspectRatios`, `sizes`, `maxRefs`, `usdPerImage(size)`, so the layout engine snaps panels to what the model can
draw and the estimate is exact. The Vertex path reuses `googleCredentials()`, the `google_veo` integration's project
id and spend cap; cost rows use provider `google_vertex`, resource = model id, `meta.comicId`.

---

## 6. Style and character consistency

The hard part. Layered, cheapest first:

1. **Stable prompt blocks.** Every panel prompt = `[style block] + [character blocks for who is in the panel] +
   [setting block] + [panel description, shot, mood] + [hard rules]`. The style and character blocks are byte-identical
   across panels. Hard rules: no text, letters, speech bubbles, signatures or watermarks in the picture; leave
   breathing room for balloons at the top of the frame.
2. **Character sheets as references.** Before drawing panels, one sheet per (character, style): a model sheet image
   (turnaround + expressions on a neutral background). Every panel with that character sends its sheet as a reference
   image. A member may upload their own sheet or photo-to-style reference instead.
3. **Style references.** A style may hold 1–4 reference images (uploaded or a previously accepted panel, "dùng làm
   mẫu phong cách"), sent with every panel.
4. **Continuity anchor.** The previous panel of the same page (and the first panel that showed the same setting)
   is sent as a reference with the instruction "same place, same lighting, keep continuity".
5. **Reference budget.** When refs exceed the model's `maxRefs`, priority is: sheets of the characters in the panel →
   setting anchor → style refs → previous panel.

Optional quality gate (flag-able, off by default in v1): Claude (vision) compares a drawn panel with the sheets of its
characters and the panel description and returns `{ ok, problems[] }`; a failed panel is redrawn once automatically
with the problems appended. Adds ~$0.01–0.02 per panel; worth measuring on real comics before turning on.

**Style presets** (platform rows, `organization_id` null), each = prompt block + storytelling notes + defaults
(colour / b&w, panel density, balloon shape, lettering font):

`Manga (đen trắng, screentone)`, `Webtoon màu`, `Truyện tranh Mỹ (mực + màu phẳng)`, `Ligne claire (Tintin)`,
`Sách tranh thiếu nhi (màu nước)`, `Noir`, `Chibi`, `Tranh Đông Hồ / dân gian` (a local flavour worth testing).

**Custom styles** (`/app/comics/styles`, any writer, like `/app/voices`): name, prompt block (≤ 1 000 chars), negative
notes, colour mode, reference images, lettering font + balloon style, default reading direction and panel density;
"Vẽ thử" draws one sample panel from a fixed test scene so styles can be compared ($0.07, recorded).

**Characters** (`/app/comics/characters`, reusable across comics): name, role, visual description (English, the
form offers "Dịch sang tiếng Anh" with Haiku), personality / way of speaking (used by the adaptation for dialogue),
reference images, and the cached sheets per style.

---

## 7. Data model (migration 0031)

All org-scoped tables take RLS `<table>_org_isolation` for `ai_news_app` (migration 0021 rules); platform presets
are rows with `organization_id` null, readable by every workspace like `voice_presets`.

```
comic_styles        id, organization_id (null = preset), name, prompt, negative, colour_mode ('colour'|'bw'),
                    reference_keys text[], font, balloon_style, reading_direction, panel_density, storytelling_notes,
                    created_by, created_at, updated_at
comic_characters    id, organization_id, name, role, visual, personality, reference_keys text[],
                    created_by, created_at, updated_at
comic_character_sheets
                    id, organization_id, character_id → comic_characters, style_id → comic_styles,
                    image_key, model, prompt, status ('draft'|'accepted'), created_at
                    unique (character_id, style_id) where status = 'accepted'
comics              id, organization_id, owner_id, title, story text, language, page_target int null (null = auto),
                    format, reading_direction, style_id, style_snapshot jsonb, text_model, image_model,
                    audience, options jsonb, state ('created'|'adapted'|'script_approved'|'drawing'|'drawn'|'exported'),
                    current_version_id, busy_step, busy_progress, last_error, cost_usd numeric,
                    lock_version, created_at, updated_at
comic_cast          comic_id, character_id, role                      (pk comic_id + character_id)
comic_versions      id, organization_id, comic_id, parent_id, kind ('adapt'|'edit'|'draw'|'letter'),
                    doc jsonb, changes jsonb, created_by, created_at  -- immutable, like `timelines`
comic_images        id, organization_id, comic_id, panel_id, kind ('panel'|'sheet'|'sample'), image_key, width, height,
                    model, prompt, refs text[], instruction, cost_usd, meta jsonb (faces, finishReason), created_at
comic_exports       id, organization_id, comic_id, version_id, kind ('png'|'pdf'|'webtoon'|'zip'),
                    status, keys text[], error, created_by, created_at
```

The **document** (`comic_versions.doc`, schema in `comic/schema.ts`) is the single source for the reader, editor and
export: format + page size in px, style snapshot, cast snapshot, pages → panels (rect, `imageId` selected,
`variants[]`, crop `focus` / zoom, script fields) → lettering (kind, text, rect, tail target, font size, auto/manual).
It stores R2 keys, never URLs (presigned at view / export time, as for timelines). Every save is a new version with
`parent_id` and `changes`; drawing a panel adds a variant and selects it in a new `draw` version.

R2: `media/<org>/comics/<comic>/panels/…`, `…/sheets/…`; reusable sheets and style refs under
`library/comics/<org>/…` (never deleted: versions reference them; `assertKeysAllowed` extended to reject another
workspace's keys); exports under `renders/comics/<org>/<comic>/…`.

Feature flag `comics` (default off), quota resource `comic_images` (default 120 / user / day; `quota.comic_images`
activity per image), both visible in `/admin`. Activity types: `comic.created`, `comic.adapted`, `comic.script_approved`,
`comic.panel_drawn`, `comic.panel_redrawn`, `comic.exported`, `comic_style.*`, `comic_character.*`.

---

## 8. Jobs

Inngest functions follow the existing rules: typed `eventType()` triggers, `busy_step` + `busy_progress` on the
`comics` row set when queued and cleared in the function and `onFailure`, `reportProgress` inside each `step.run`,
first step = `eventSuperseded` check against the newest version, permanent LLM / image errors → `NonRetriableError`.
Concurrency: `comic-draw` limits to 4 parallel image calls per workspace (Vertex rate limits) and 1 run per comic.

| Function | Event | Steps |
|---|---|---|
| `comic-adapt` | `comic/adapt.requested` (`pageNumber?`, `instruction?`) | adapt → save `adapt` version → state `adapted` |
| `comic-cast` | `comic/cast.requested` | one step per character missing an accepted sheet in the style |
| `comic-draw` | `comic/draw.requested` (`panelIds?`, `instruction?`) | availability + quota check → one step per panel (generate → R2 → `comic_images` → faces) → `comic-letter` |
| `comic-letter` | (called) | pure auto-lettering of panels whose balloons are still `auto` → new version |
| `comic-export` | `comic/export.requested` (`kinds[]`) | `renderStillOnLambda` per page → PDF / webtoon / zip → `comic_exports` |

Queue outages: the adaptation (one call) and a single-panel redraw are short enough for a direct run from `after()`
with the same compare-and-set as `pipeline/direct.ts`; a full draw and an export only wait, as renders do today.

A failed panel never fails the comic: the panel shows the error and a "Vẽ lại" button; the run ends `drawn` with
`last_error` listing the failures.

---

## 9. Lettering

Text is never drawn by the image model: models misspell, cannot do Vietnamese diacritics reliably, and baked-in
text cannot be edited or translated. Balloons are data in the document and drawn by `ComicPage.tsx` as SVG/HTML.

- **Fonts**: comic-lettering faces with full Vietnamese coverage (candidates to verify: `Patrick Hand`, `Itim`,
  `Bangers` for SFX only if glyphs pass, fallback `Be Vietnam Pro`). One verification test renders every Vietnamese
  diacritic combination in each font.
- **Auto placement** (`lettering.ts`, pure): balloons in reading order (LTR: top-left → bottom-right; RTL for manga),
  sized from a per-font width table, placed in the panel's free area: avoid face boxes (Cloud Vision `FACE_DETECTION`,
  the same client as the face guard; drawn faces are detected well enough, fallback = the character `position` from the
  script), avoid other balloons, prefer the top band. Tail points at the speaker's face box (or the side named by
  `position`). If it does not fit, font steps down to a floor, then the panel is flagged "chữ quá dài" in the editor
  with a one-click "Rút gọn lời thoại" (Claude, like `rewrite.ts` `shorter`).
- **Manual**: drag balloon and tail handle, resize, change kind; a moved balloon becomes `manual` and is never
  re-placed automatically.
- **SFX**: big stylised words placed over the art (kind `sfx`), rotation allowed.

---

## 10. UI

Nav rail: new item "Truyện tranh" (icon `BookOpen`) between projects and "Âm thanh", shown when flag `comics` is on.
Pages (all call `requireWorkspace` themselves):

- `/app/comics`: list (cover thumb, title, pages, state, cost, owner), filters, "Tạo truyện mới".
- `/app/comics/new`: the form of §2.1; style picker as a grid of sample thumbnails; cast picker; model pickers with
  price hints; "Ước tính" line updates live from `estimateCost`.
- `/app/comics/[id]`: one page with tabs that follow the state: **Kịch bản** (outline editor), **Nhân vật** (sheets),
  **Trang** (page editor: page strip on the left, the page in the middle, inspector on the right for the selected
  panel / balloon), **Đọc** (reader: page flip on desktop, vertical scroll on phone), **Xuất** (exports + history).
  Status polling uses the existing pattern (`/api/…/status` + `router.refresh()` on `rev` change).
- `/app/comics/styles`, `/app/comics/characters`: libraries, like `/app/voices`.

The page editor is a smaller sibling of the video editor, not a plugin of it: the document, history and undo can
reuse `media/editor-history.ts` (pure, generic), but the timeline-centric shell does not fit pages.

---

## 11. Phasing

| Phase | Scope | Exit criterion |
|---|---|---|
| **M1 — Script to pages** | migration, flag, quota, presets, `/new`, adaptation, script review, sheets, drawing with Gemini Flash / Pro, auto lettering, reader, PNG export | A 6-page Vietnamese story becomes a readable comic with consistent main characters in < 10 min for < $5. |
| **M2 — Editing** | page editor (redraw with instruction, variants, crop, balloon editing, layout templates), style + character libraries, "Vẽ thử", Claude page rewrite | A member fixes a bad panel and a misplaced balloon without leaving the page. |
| **M3 — Export + models** | PDF, webtoon strip, zip; `openai` integration + GPT Image 2 adapter; optional vision quality gate | Same comic exported in three formats; switching image model per comic works. |
| **M4 — Motion comic** | turn a comic into a 9:16 video project (§11.1): one scene per lettering beat over its panel (pan / zoom over the art), voice-over per speaker with workspace voices, lettering as word-timed captions; enters the normal editor / review / render / publish flow | A 7-page comic becomes a publishable short with one click and no script call. |

### 11.1 Motion comic (M4)

Decided 2026-10-12: in scope. The comic is turned into an ordinary video project, so everything downstream (editor,
approval, render, QA, multi-channel logos, publishing) is reused unchanged and the output spec stays 1080×1920 / 30 fps /
-14 LUFS.

- **Entry point**: "Làm video" on the comic's Xuất tab: pick the pages (default all), the brand kit, the channel logo,
  narrator voice, music. It creates a `projects` row with a new `source_kind = 'comic'` (CHECK extended; `url` null like
  `text` / `topic`, so `projects_url_check` allows it), `comic_id` and `comic_version_id` (the version is frozen: later
  comic edits do not change the video; "Làm lại từ bản mới" creates a new build).
- **No script call**: `comic/motion.ts` (pure, tested) builds the script directly from the document. One scene per
  lettering beat in reading order: speech / thought / whisper / shout → a line in the speaker's voice, caption → the
  narrator, a silent panel → a 2–3 s beat with no voice-over, `sfx` → the scene's on-screen text (headline card) plus an
  optional sound from the library. A panel with three lines gives three consecutive scenes over the same art. The
  hook is the first page's first beat; the outro credits the comic ("Truyện: <title>") instead of a source link.
  Fetch, faithfulness and topic research are skipped for this kind (the text is the member's own fiction).
- **Voices per character**: `comic_characters.voice_preset_id` (nullable, migration with M4) picks a workspace voice
  for each character; unset characters and the narrator fall back to the project's voice. TTS runs per scene as today,
  so a scene has exactly one speaker. Word timings drive the captions as for any project, using the lettering text.
- **Visuals**: each scene's visual is its panel image (`comic_images` copied as an `assets` row, origin `upload`,
  provider `comic`, credit "Minh hoạ AI (Gemini)"). Panels are rarely 9:16, so the existing framing does the work:
  a wide panel is a landscape still (full width on its blurred copy, composition 0.12.0), a tall or square one is
  cover-cropped with `focus` set on the speaker's face box from `comic_images.meta.faces` and a slow Ken Burns towards
  it; consecutive scenes on the same panel continue the move instead of restarting it. The rule "a picture must not
  repeat within a video" and the ≤ 5 s shot cadence check are relaxed for `source_kind = 'comic'` (the same panel over
  several beats is the format), in `prepare-assets` and in `media/editor-checks.ts`.
- **Balloons**: not drawn in the video. The lettering text becomes the voice-over and the captions; a balloon burned
  into a 1080×1920 frame would be unreadable and would duplicate the captions. A per-project switch "Giữ bóng thoại"
  renders each panel with its balloons as the still instead (a single-panel `renderStillOnLambda` of `ComicPage`), for
  silent / music-only cuts.
- **Length**: ~4 s per spoken beat, so a 30-panel comic runs about 2 minutes. The new-video form shows the estimate
  per platform and warns past the platform limits (the editor's existing duration check); picking fewer pages is the
  lever. Long comics can be cut into parts: "Chia thành tập" makes one project per page range.
- **Originality and disclosure**: the art is our own generated media, so it does not count against the third-party
  footage limits (`media/originality.ts`); `projects.ai_disclosure` is set, as for any AI still.
- **Composition**: no new visual kind is needed for v1 of M4 (stills + Ken Burns + captions already exist). A later
  "panel reveal" transition (the next panel slides in along the page's reading order) would be a composition bump.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Characters drift between panels | sheets + refs + stable prompt blocks (§6); per-panel redraw; optional vision gate; Pro model option. |
| Cost surprises (40 panels × redraws) | estimate before drawing; `comic_images` daily quota; Vertex spend cap already enforced; running total on the comic. |
| Model refusals on story content (violence, real people) | refusals surface per panel with the reason; Claude fallback for the adaptation; story text from the member is their responsibility (terms note on the form); no real public figures in sheets (prompt rule). |
| Copyrighted characters / styles ("draw it like Doraemon") | style prompts name techniques, not artists or franchises; the form warns; presets avoid named IP. |
| AI disclosure | exports carry a small "Minh hoạ bởi AI (Gemini)" credit on the last page by default (off switch for workspace admins); Gemini output keeps its SynthID watermark. |
| Vietnamese text in pictures | never asked of the model (§9). |
| Vertex rate limits on bursts | per-workspace concurrency 4 in `comic-draw`, Inngest retries with backoff. |

---

## 13. Open questions (recommendation first)

1. **Panel-by-panel or whole-page generation?** Recommended: **panel-by-panel**, composed by the app. Cheaper
   redraws, exact layouts, editable lettering, any page format. Whole-page generation (Gemini Pro can draw a full
   page) gives more "organic" layouts but makes every fix a full-page redraw and bakes the gutters in. Could be added
   later as a style option.
2. **Script review mandatory?** Recommended: **yes by default**, with a "Vẽ luôn" (skip review) checkbox for people
   who trust it. It is the cheapest place to fix a story.
3. **Which image models in v1?** Recommended: **Gemini 3.1 Flash Image + Gemini 3 Pro Image** (Vertex, nothing new
   to contract). OpenAI / others in M3 once someone needs them.
4. **Who can use it?** Recommended: any workspace writer when the flag is on, same as voices and sounds; admins tune
   the quota.
5. **Page formats to offer.** Recommended: `A4 dọc`, `Truyện tranh Mỹ (6.625×10.25")`, `Manga B6`, `Webtoon (cuộn dọc)`,
   `Vuông 1:1` (social carousel), `9:16` (stories). Print-ready bleed / CMYK is out of scope.
6. ~~**Motion comic (M4)** — wanted at all?~~ **Decided: yes**, phase M4 (§11.1).
