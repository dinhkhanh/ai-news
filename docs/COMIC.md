# Comic studio: design

Status: **accepted** 2026-10-12 (decisions in §13). M1–M4 built (§11.2–§11.5).

A standalone feature: a member pastes a story (plain text), picks or defines a style, a cast and the AI models,
and the app produces a short comic, 5–10 pages by default or as many as asked. It shares the app's infrastructure
(auth, workspaces, Claude client, Vertex image generation, R2, Inngest, cost and activity rows, Remotion Lambda)
but none of the news pipeline: no article, no timeline, no publishing.

Decisions taken on the open questions are at the end (§13).

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
| GPT Image 2 (OpenAI) | `gpt-image-2` | ~0.03–0.08 | up to 16 | M3 (§11.4), `openai` integration |
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
                    storytelling_notes, reference_keys text[], font, reading_direction, swatch, position,
                    created_by, created_at, updated_at                       -- 8 presets seeded by the migration
comic_characters    id, organization_id, name, role, visual, personality, reference_keys text[],
                    created_by, created_at, updated_at
comics              id, organization_id, owner_id, title, story, language, page_target (null = auto, CHECK 1–40),
                    format, reading_direction, style_id, style_snapshot jsonb, text_model, image_model, audience,
                    options jsonb (dialogue, free, review, castIds, font, credit),
                    state ('created'|'adapted'|'script_approved'|'drawing'|'drawn'|'exported'),
                    current_version_id, busy_step, busy_progress, last_error, cost_usd, lock_version, timestamps
comic_versions      id, organization_id, comic_id, parent_id, kind ('adapt'|'edit'|'draw'|'letter'),
                    doc jsonb, changes jsonb, created_by, created_at        -- immutable, like `timelines`
comic_images        id, organization_id, kind ('panel'|'sheet'|'sample'), comic_id, panel_id, character_id, style_id,
                    status ('draft'|'accepted' for sheets only), image_key, width, height, model, prompt, refs text[],
                    instruction, cost_usd, meta jsonb (aspect, faces), created_by, created_at
                    unique (character_id, style_id) where kind = 'sheet' and status = 'accepted'
comic_exports       id, organization_id, comic_id, version_id, kind ('png'|'pdf'|'webtoon'|'zip'),
                    status ('queued'|'rendering'|'done'|'failed'), keys text[], error, created_by, timestamps
```

As built (M1), two tables of the first draft were folded into others: the cast lives in the document
(`doc.cast[]`, each member's `characterId` links a library character; proposed characters carry a `new:<slug>` ref
until the script is approved, which creates them in `comic_characters`), and character sheets are `comic_images`
rows of kind `sheet`.

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

### 11.2 M1 as built (2026-10-12)

- Pure modules with tests: `packages/video/src/comic.ts` (document schema), `comic-view.tsx` (`ComicPageView`, the page
  renderer shared by the app and the export), `apps/web/src/lib/comic/{models,layout,lettering,script,doc,prompts}.ts`.
- Server: `lib/comic/{service,adapt,images,drawing,flow}.ts`; `media/generate.ts` now exposes `vertexImageAccess` and
  `vertexGenerateImage` (reference images, any aspect ratio) for both the news stills and the comics.
- Jobs: `comic-adapt`, `comic-cast`, `comic-draw` (sheets first, then panels four at a time, each picture written into
  the document as it lands and re-lettered), `comic-export` (PNG per page via `renderStillOnLambda`).
- UI: `/app/comics` (list), `/app/comics/new`, `/app/comics/[id]` with tabs Kịch bản / Nhân vật / Trang / Đọc / Xuất.
- To switch it on: apply migration 0031, deploy `packages/video` 0.18.0 (composition `ComicPage`, needed by the
  export), make sure the `google_veo` integration is on, then turn on flag `comics` in /admin/integrations.
- Left for M2: style / character library pages (`/app/comics/styles`, `/app/comics/characters`), "Vẽ thử", uploading
  one's own sheet, picking among a panel's variants, crop / pan, moving balloons by hand. The vision quality gate moved
  to M3.

### 11.3 M2 as built (2026-10-12)

- **Document** (`packages/video` **0.19.0**, `ComicPageView` changed): a panel may carry `crop` `{ x, y, zoom }`
  (`panelCropSchema`, none = centred cover). The picture still covers its frame; `x` / `y` pick what stays in view and
  `zoom` (1–4, the editor offers 1–3) enlarges it around that point (`object-position` + `scale` with the same origin).
  `pictureToPage` maps a point of the picture to the page through the crop, so `facesOnPage` (and therefore automatic
  balloons and tails) follow the framing.
- **Pure edits** (`lib/comic/doc.ts`, tested): `selectVariant`, `removeVariant` (never the picture shown), `setPanelCrop`
  (clamped, a near-centred crop is stored as none, re-letters), `placeBalloon` (manual, kept on the page, at least 2.5 ×
  1.6 font sizes, no tail for caption / sfx, re-letters the automatic balloons around it), `editBalloon` (text, kind,
  speaker, font size: an automatic balloon is re-lettered, a manual one keeps its centre, is resized to its text and its
  tail re-aimed when the speaker changes), `resetBalloon`, `addBalloon`, `deleteBalloon`, `setBalloonTexts`,
  `balloonOverflows`. `lib/comic/editor-ops.ts` is the one zod union of editor operations (`place`, `balloon`,
  `resetBalloon`, `addBalloon`, `deleteBalloon`, `variant`, `removeVariant`, `crop`, `layout`) and `applyEditorOp`, used
  by the browser for the optimistic copy and by the server inside `updateDoc` (under the row lock), so both compute the
  same document. Each op has its activity type (`OP_ACTIVITY`).
- **Page editor** (`[id]/page-editor.tsx`, tab Trang): the page with an overlay; click a panel or a balloon to inspect
  it. Balloons drag to move, a corner handle resizes, a dot moves the tail; arrow keys nudge (Shift = more). Edits apply
  locally at once and are saved one after another through `applyEdit` (`editor-actions.ts`; sliders and text are
  debounced 500 ms); every save is a new version. The page refreshes from the server only when nothing is pending.
  Panel inspector: redraw with an instruction, optionally "giữ bố cục" (the current picture goes first among the
  reference images, `RefCandidates.base`, event field `keepComposition`); the variants (pick, remove); crop sliders;
  the lettering list; a balloon that overflows offers "Rút gọn lời thoại" (`lib/comic/shorten.ts`: the comic's script
  model, effort low, one structured call for the overflowing lines with a word budget of 60 %, cost recorded,
  `comic.lines_shortened`); add a line; "Dùng hình này làm mẫu phong cách" (`addStyleSample`, the comic's own
  workspace style only, at most 4 samples, the comic's style snapshot updated too). The page's layout template is a select.
- **Libraries** (`/app/comics/styles`, `/app/comics/characters`, tabs `comic-tabs.tsx`; `library-actions.ts`,
  `lib/comic/library.ts`): workspace styles (create, edit, duplicate any preset or style, delete when no comic uses it,
  because `comic_images` cascade from styles), "Vẽ thử" (one sample of `stylePreviewPrompt` in the picked model, drawn
  inside the request, `maxDuration` 120; the latest three show on the style card and in the new-comic picker),
  characters (create, edit, delete, draw a sheet in any style with an instruction, accept a draft sheet). Reference
  images for a style or a character (≤ `MAX_REFS` = 4) and one's own sheet ("Tải bản mẫu của bạn", also on a comic's
  Nhân vật tab) go browser → presigned PUT → `library/comics/<org>/uploads/` → `checkUpload` (this workspace's prefix,
  PNG / JPEG / WebP by content, ≤ 10 MB, short side ≥ 256 px; a failing file is deleted). An uploaded sheet is a
  `comic_images` row of kind `sheet`, model `upload`, accepted at once.
- To switch it on after M1: deploy `packages/video` **0.19.0** (the page renderer changed, and the export must match the
  reader); no migration. The bucket CORS (`infra/r2/cors.json`) must allow PUT from the app's origin, as for the video
  editor's uploads.
- Not done / later: undo in the page editor and a version list to restore from (every edit is already an immutable
  version in `comic_versions`, so both are UI only), rotating SFX, the vision
  quality gate (M3). Not tested against the live services here: Claude (shorten), Vertex (Vẽ thử, sheets, redraw with
  the current picture), R2 uploads, the Lambda export with crops.

---

### 11.4 M3 as built (2026-10-12)

- **Exports** (`comic-export`, one request = one `comic_exports` row per kind, all of the same version; event field
  `exportIds`): `png` (each page by `ComicPage` on Lambda, `trang-NN.png`; the pages of an earlier finished PNG export
  of the same version are reused instead of rendered again), `pdf` (the pages again as JPEG 90 under `tmp/`, then
  `lib/comic/files.ts` `jpegPdf`: PDF 1.4, one DCTDecode image per page, A4 / US comic / B6 pages at their print size,
  the others at px × 0.75 pt, UTF-16 title), `webtoon` (`planStrip` in `packages/video/src/comic.ts`: the pages one
  under another at 800 px wide, cut into files of at most 8 000 px, each cut in a gutter between panels and balloons
  when one lies in the last three quarters of the part, else a hard cut; each part rendered as JPEG by the new
  `ComicStrip` composition, which places slices of `ComicPageView`), `zip` (all of the above, stored, UTF-8 names;
  choosing zip renders every kind). Files live under `renders/comics/<org>/<comic>/<export>/`, named after the title
  slug. Tab Xuất: checkboxes (PNG + PDF by default), a download link per file. No new npm dependency (the zip and PDF
  writers are ~150 lines, tested with `unzip -t`, `pdfinfo` and `pdftoppm`). `packages/video` **0.20.0** (ComicStrip).
- **Models**: `ImageModel` has `provider` (`vertex` | `openai`) and `apiId`; `drawComicImage` dispatches on it and
  records the cost under the provider's name (`google_vertex` / `openai`, resource = the provider's model id).
  GPT Image 2 (`lib/comic/openai-image.ts`, raw fetch, no SDK): `/v1/images/edits` multipart with the references as
  `image[]`, `/v1/images/generations` without references; `quality` medium, PNG; sizes from `openaiSize` (1024², 1024 ×
  1536, 1536 × 1024 where they fit, otherwise ~1.5 MP with edges a multiple of 16); no `input_fidelity` (GPT Image 2
  rejects it). Cost from the response's `usage` (text in $5, image in $8, image out $30 per MTok), the catalogue
  estimate ($0.05 + $0.006 per reference) when it has none. Moderation blocks, billing / spend-limit codes, 401 / 403
  and other 4xx are permanent (the panel keeps the message); 429 and 5xx are tried again twice within the first
  minute. The `openai` integration (/admin/integrations: API key in Vault, monthly spend cap over `usage_costs`
  provider `openai`) is read at draw time, so the key never goes through step state. `comicDrawAccess(userId,
  modelId)` checks the model's integration. Adding GPT Image 2.5 (or another provider) is a catalogue entry (+ an
  adapter for a new provider).
- **Switching models per comic**: card "Mô hình" on the Kịch bản tab (`saveComicSettings`, refused while a step runs,
  `comic.settings_changed` with before / after): image model, script model and the quality gate. Later drawings,
  redraws, sheets and re-adaptations use the new models; pictures already drawn stay (and stay as variants).
- **Quality gate** (option `qualityGate` in `comics.options`, a checkbox on the new-comic form and the Mô hình card, off
  by default): after a panel is drawn, `lib/comic/quality.ts` sends Claude Sonnet 5.5 (`MODELS.comicCheck`, effort
  low) the sheets of the panel's characters, the panel and `qualityBrief` (script, characters, what counts as a
  problem) and gets `{ ok, problems[] }` (cost recorded, `comic.panel_checked`). A failed panel is redrawn once in its
  own step (`panel-<id>-fix`) with the problems appended to the direction, if the daily quota still allows; the first
  picture stays as a variant. A failed check never fails the panel.
- To switch it on after M2: deploy `packages/video` **0.20.0**; for GPT Image, add the `openai` integration (key,
  spend cap; the OpenAI organisation may need verification for image models). No migration.
- Not tested against the live services here: OpenAI, Claude vision, Remotion Lambda (ComicStrip, JPEG stills), R2.

### 11.5 M4 as built (2026-10-12)

- **Entry**: card "Làm video (truyện động)" on the Xuất tab (`video-card.tsx`, action `makeComicVideo` in
  `app/comics/video-actions.ts`): page range (default all), "Chia thành tập" with N pages per episode (≤ 10 episodes),
  narrator voice, brand kit, channel logo, music on / off; a live length estimate per episode (`pageSeconds` + 5 s)
  against the platforms' limits (`PLATFORM_SPEC.maxDurationSec`), and the count of undrawn panels, which are left out.
  Below, the videos already made from the comic, marked "bản cũ" when the comic changed since.
- **Project** (migration **0032**): `projects.source_kind = 'comic'` (CHECK extended; `projects_url_check` allows no
  link), `comic_id` and `comic_version_id` (FKs, set null on delete; index on `comic_id`). One click inserts per
  episode, in one transaction: the project (state `scripted`, tone `casual`, `ai_disclosure` on, busy `assets`), a
  confirmed article holding the lines (`fetch_method = 'comic'`) and script v1 (`model = 'comic'`, cost 0); then
  `project/comic-build.requested`. Activity: `project.created` per project and `comic.video_created`. Making the video
  again after editing the comic makes a new project (the version stays frozen in the old one).
- **Script without a model** (`lib/comic/motion.ts`, pure, tested): `comicBeats` walks the chosen pages in reading
  order; per drawn panel one beat per non-sfx line (captions and lines without a known speaker → narrator, the rest →
  the speaker's cast member), a panel with nothing to read → a 2.5 s silent beat, sound effects → the on-screen text of
  the panel's first beat (2 s when they are all there is). `speakerFace` finds the speaker's face box: faces carry no
  names, so with as many faces as foreground characters the n-th face from the left is the n-th character, otherwise
  the face nearest to the speaker's staging position. `comicToScript`: scenes `s1…sN`, the first is the hook with the
  title (and "Tập n/m") on screen, a narrator CTA closes over the last panel ("Hết truyện …" or "Còn tiếp…" for an
  episode), metadata from the title / logline with comic hashtags, and `scenes_json.comic` = the comic, version,
  pages, episode, music and per scene the panel, picture, faces, speaker face and reader. A request for a new script
  on a comic project is refused (action and pipeline).
- **Build** (`inngest/functions/prepare-comic.ts`; `prepare-assets` forwards a comic project there, so "Dựng lại"
  works too): the narrator voice is the project voice, a character's line uses `comic_characters.voice_preset_id`
  (new, picked on `/app/comics/characters`; null = narrator; a voice that cannot read the language falls back as
  usual), silent beats get no voice. The panels are copied (R2 `copyObject`) into the project's media as `assets` rows
  (`origin` upload, `provider` comic, `provider_id` = comic_images id, credit "Minh hoạ AI (Gemini)" / "(GPT Image)",
  `meta.frame` = the panel's faces), once per picture; a rebuild reuses them, and deleting the comic leaves the video
  intact. `composeComicDoc` (`lib/comic/motion-doc.ts`, pure, tested): one shot per beat, framed by the face guard on
  the speaker's face (every face for the narrator), Ken Burns as the face guard decides; a wide panel gets the
  existing landscape treatment of the composition. Music by the project tone unless off; then the usual mix, timeline
  version, `state = composed`, `ai_disclosure`, and auto mode. Outro credit: "Nguồn: Truyện “<title>”" (no link).
  Re-voicing a scene in the editor keeps that scene's voice (`build_json.voice.scenes[].presetId`).
- **Checks**: the editor passes `comic` to `editor-checks.ts`; the shot cadence, repeated-picture and faithfulness
  checks stay quiet, and the face check only reports cropped / covered faces (a panel framed on its speaker is
  intended). Everything else (duration limits, hook text, audio) runs as for any project.
- **Not built** (later): "Giữ bóng thoại" (panels rendered with their balloons), a library sound under sound
  effects, one camera move continuing across consecutive beats of a panel (needs a composition change: each beat
  starts its own Ken Burns, framed on its own speaker), a music picker. No `packages/video` change, so no redeploy;
  run migration 0032.
- Not tested against the live services here: Google TTS, the media Lambda mix, R2 copies.

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

## 13. Decisions (2026-10-12)

All six questions are settled; the recommendations were taken.

1. **Panel-by-panel generation**, composed by the app: cheaper redraws, exact layouts, editable lettering, any page
   format. Whole-page generation may come back later as a style option.
2. **Script review on by default**, with a "Vẽ luôn" (skip review) checkbox.
3. **Image models in v1: Gemini 3.1 Flash Image + Gemini 3 Pro Image** (Vertex). GPT Image 2 (OpenAI) added in M3 (§11.4).
4. **Any workspace writer** can use it while flag `comics` is on; admins tune the `comic_images` quota.
5. **Page formats**: `A4 dọc`, `Truyện tranh Mỹ (6.625×10.25")`, `Manga B6`, `Webtoon (cuộn dọc)`, `Vuông 1:1`, `9:16`.
   No print bleed / CMYK.
6. **Motion comic: yes**, phase M4 (§11.1).
