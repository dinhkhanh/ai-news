import { NonRetriableError } from "inngest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inngest } from "../client";
import { projectSceneRegenerateRequested } from "../events";
import { reportProgress, tickProgress } from "@/lib/progress";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { fetchSceneBroll } from "@/lib/media/broll";
import { isPermanentLlmError, LlmOutputError } from "@/lib/llm/client";
import { designMotionShot } from "@/lib/llm/motion";
import { backdropCandidates, buildFromDoc, EDITOR_FPS, setShot, voicePlacement, type EditorBackdrop, type EditorDoc, type EditorScene } from "@/lib/media/editor";
import { shotWords } from "@/lib/media/motion-plan";
import { analyseAsset, faceGuardAvailable } from "@/lib/media/faces";
import { frameStill, overlayZones, storedFrame } from "@/lib/media/framing";
import { aiImagesAvailable, generateSceneImages } from "@/lib/media/generate";
import { pickMusic } from "@/lib/media/music";
import { findRelatedImages, storeRelatedImages } from "@/lib/media/related";
import { loadPronunciations, loadVoicePreset, synthesizeScene } from "@/lib/media/tts";
import { LEAD_MS, shotsNeeded } from "@/lib/media/timeline";
import { tierAllowed } from "@/lib/media/visual-plan";
import { presignGet, r2Key } from "@/lib/r2";
import { docOfRow, saveTimelineVersion } from "@/lib/review";

/**
 * Phase 4 (docs/PLAN.md §4.7 "regenerate one scene's B-roll or VO, change
 * music", plus a motion graphic designed by Claude Opus 5.5 for one shot or the
 * whole scene, and the whole voice-over read again, in another voice if the
 * editor picked one): redo one part of the editor document and store the result as a
 * new timeline version (kind = regenerated) on top of the version the editor
 * was looking at. A B-roll re-search follows the visual priority
 * (`visual-plan.ts`) from tier 2: other outlets' pictures of what the scene's
 * voice-over names (`newsTerms`, face-guarded), then stock, then AI stills
 * when stock has nothing; a political story stops after tier 2. The optimistic
 * lock in saveTimelineVersion rejects the result if someone saved another
 * version meanwhile.
 */
export const regenerateSceneFn = inngest.createFunction(
  {
    id: "regenerate-scene",
    triggers: [projectSceneRegenerateRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 4 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy, what, sceneId } = event.data.event.data;
      const message = event.data.error?.message ?? "regeneration failed";
      await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
        tx.update(schema.projects).set({ busyStep: null, busyProgress: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "scene.regenerate_failed", payload: { what, sceneId, error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, timelineId, what, sceneId, voiceover, voicePresetId, brollTerms, engine, instruction, shot, backdrop: backdropPick } = event.data;
    const ctx = { userId: requestedBy, organizationId };
    const pctx = { ...ctx, projectId };
    const buildId = nanoid(8);

    const base = await step.run("load", async () => {
      await reportProgress(pctx, { label: "Đọc phiên bản hiện tại", pct: 5 });
      const row = await withOrgContext(ctx, async (tx) => {
        const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
        if (!project) throw new NonRetriableError("Project not found in this workspace");
        const timeline = await tx.query.timelines.findFirst({ where: and(eq(schema.timelines.projectId, projectId), eq(schema.timelines.id, timelineId)) });
        if (!timeline) throw new NonRetriableError("Timeline version not found");
        await tx.update(schema.projects).set({ busyStep: "regenerate", lastError: null }).where(eq(schema.projects.id, projectId));
        const article = await tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), columns: { siteName: true } });
        // A motion comic reads each line in its speaker's voice: re-voicing keeps the voice the build gave each scene.
        const comicVoices: Record<string, string> =
          project.sourceKind === "comic" ? Object.fromEntries(((timeline.buildJson as { voice?: { scenes?: Array<{ sceneId: string; presetId?: string | null }> } }).voice?.scenes ?? []).flatMap((v) => (v.presetId ? [[v.sceneId, v.presetId]] : []))) : {};
        return { tone: project.tone, political: project.political, sourceUrl: project.canonicalUrl ?? project.url, voicePresetId: project.voicePresetId, comicVoices, motionEngine: project.motionEngine, photoSketch: project.photoSketch, sourceName: article?.siteName ?? null, timeline };
      });
      const { doc } = docOfRow(row.timeline);
      const stock = ((row.timeline.buildJson as { stock?: Record<string, unknown> }).stock ?? {}) as Record<string, unknown>;
      return { tone: row.tone, political: row.political, sourceUrl: row.sourceUrl, voicePresetId: row.voicePresetId, comicVoices: row.comicVoices, motionEngine: row.motionEngine, photoSketch: row.photoSketch, sourceName: row.sourceName, version: row.timeline.version, doc, stock };
    });

    const sceneIdx = base.doc.scenes.findIndex((s) => s.id === sceneId);
    if (what !== "music" && what !== "voices" && sceneIdx < 0) throw new NonRetriableError(`Scene ${sceneId} is not in timeline v${base.version}`);
    const scene = base.doc.scenes[sceneIdx] as EditorScene | undefined;

    let next: EditorDoc = base.doc;
    const changes: string[] = [];
    const build: Record<string, unknown> = {};

    if (what === "voice" && scene) {
      const text = (voiceover ?? scene.voiceover).trim();
      if (text.length < 2) throw new NonRetriableError("Voice-over text is empty");
      const v = await step.run("voice", async () => {
        await reportProgress(pctx, { label: `Đọc lại lời cảnh ${scene.id} (Google TTS)`, pct: 20 });
        // The project's voice: the build form and the editor's whole-video re-voice change it, so it is the voice of this version.
        const preset = await loadVoicePreset(ctx, base.doc.language, base.comicVoices[scene.id] ?? base.voicePresetId);
        const pronunciations = await loadPronunciations(ctx, base.doc.language);
        return synthesizeScene({ sceneId: scene.id, text, language: base.doc.language, preset, pronunciations, r2Key: r2Key.media(organizationId, projectId, `vo/${buildId}-${scene.id}.wav`) }, pctx);
      });
      next = {
        ...base.doc,
        scenes: base.doc.scenes.map((s, i) => (i === sceneIdx ? { ...s, voiceover: text, voice: { key: v.key, durationMs: v.durationMs, words: v.words }, captions: null, durationSec: Math.round((v.durationMs / 1000) * 10) / 10 } : s)),
      };
      changes.push(`${scene.id}: đọc lại lời${text !== scene.voiceover ? " (văn bản mới)" : ""} · timing ${v.timing}`);
      build.lastVoice = { sceneId: scene.id, timing: v.timing, matched: v.matched, words: v.words.length, costUsd: v.costUsd };
    }

    if (what === "voices") {
      // Every scene with words is read again from its saved text; a new voice becomes the project's once the version is saved.
      const presetId = voicePresetId === undefined ? base.voicePresetId : voicePresetId;
      const spoken = base.doc.scenes.filter((s) => s.voiceover.trim().length >= 2);
      if (!spoken.length) throw new NonRetriableError("Không cảnh nào có lời đọc");
      const setup = await step.run("voices-setup", async () => {
        await reportProgress(pctx, { label: `Đọc lại toàn bộ lời (${spoken.length} cảnh)`, pct: 5, total: spoken.length });
        const preset = await loadVoicePreset(ctx, base.doc.language, presetId);
        // A motion comic keeps each speaker's voice; only the narrator's lines take the chosen one.
        const presets: Record<string, Awaited<ReturnType<typeof loadVoicePreset>>> = { [preset.id]: preset };
        for (const id of new Set(Object.values(base.comicVoices))) presets[id] ??= await loadVoicePreset(ctx, base.doc.language, id);
        return { preset, presets, pronunciations: await loadPronunciations(ctx, base.doc.language) };
      });
      const voices = await Promise.all(
        spoken.map((s) =>
          step.run(`voice-${s.id}`, async () => {
            const preset = setup.presets[base.comicVoices[s.id] ?? setup.preset.id] ?? setup.preset;
            const v = await synthesizeScene({ sceneId: s.id, text: s.voiceover.trim(), language: base.doc.language, preset, pronunciations: setup.pronunciations, r2Key: r2Key.media(organizationId, projectId, `vo/${buildId}-${s.id}.wav`) }, pctx);
            await tickProgress(pctx, { label: "Đọc lại lời", total: spoken.length, from: 5, to: 70 });
            return v;
          }),
        ),
      );
      const byScene = new Map(voices.map((v) => [v.sceneId, v]));
      next = {
        ...base.doc,
        scenes: base.doc.scenes.map((s) => {
          const v = byScene.get(s.id);
          return v ? { ...s, voiceover: s.voiceover.trim(), voice: { key: v.key, durationMs: v.durationMs, words: v.words }, captions: null, durationSec: Math.round((v.durationMs / 1000) * 10) / 10 } : s;
        }),
      };
      const changed = voicePresetId !== undefined && voicePresetId !== base.voicePresetId;
      changes.push(`Đọc lại toàn bộ lời (${voices.length} cảnh) bằng giọng ${setup.preset.name}${changed ? " (giọng mới)" : ""}`);
      build.voice = {
        preset: setup.preset.voice,
        presetId: setup.preset.id,
        presetName: setup.preset.name,
        model: setup.preset.model,
        scenes: voices.map((v) => ({ sceneId: v.sceneId, key: v.key, durationMs: v.durationMs, timing: v.timing, matched: v.matched, words: v.words.length, chars: v.chars, spokenText: v.spokenText, pronunciations: v.pronunciationsApplied, costUsd: v.costUsd, ...(base.comicVoices[v.sceneId] ? { presetId: base.comicVoices[v.sceneId] } : {}) })),
      };
    }

    if (what === "broll" && scene) {
      const terms = (brollTerms?.length ? brollTerms : scene.brollTerms).map((t) => t.trim()).filter(Boolean);
      const newsTerms = (scene.newsTerms ?? []).map((t) => t.trim()).filter(Boolean);
      const stockAllowed = tierAllowed("stock", base.political);
      if (!newsTerms.length && (!stockAllowed || !terms.length)) {
        throw new NonRetriableError(stockAllowed ? "Add at least one English search term for the B-roll" : `Tin chính trị: không dùng stock hay ảnh AI, và cảnh ${scene.id} không nêu tên người / nơi / sự kiện nào để tìm ảnh thật`);
      }
      const sceneMs = (scene.voice?.durationMs ?? scene.durationSec * 1000) + scene.holdMs;
      const wantSec = Math.min(5, sceneMs / 1000);
      const keep = shotsNeeded(sceneMs);
      type Visual = EditorScene["visual"];

      /* ---- tier 2: other outlets' pictures of what the voice-over names, face-guarded under this scene's overlays ---- */
      const related = await step.run("related", async (): Promise<{ visuals: Visual[]; found: number; stored: number; errors: string[]; costUsd: number }> => {
        if (!newsTerms.length) return { visuals: [], found: 0, stored: 0, errors: [], costUsd: 0 };
        await reportProgress(pctx, { label: `Tìm ảnh báo khác cho cảnh ${scene.id}: “${newsTerms[0]}”`, pct: 15 });
        const found = await findRelatedImages({ query: newsTerms[0], sceneIds: [scene.id], language: base.doc.language, excludeUrls: base.sourceUrl ? [base.sourceUrl] : [], want: keep });
        // Pictures already in this project are skipped by the content-hash check in storeRelatedImages, so a retry brings something new.
        const stored = await storeRelatedImages(found.images, { buildId, max: keep + 1 }, pctx);
        const guard = await faceGuardAvailable();
        const zones = overlayZones({
          kind: scene.kind,
          headline: scene.onScreenText,
          caption: base.doc.brand.caption,
          headlineStyle: base.doc.brand.headline,
          hasCaptions: Boolean(scene.voiceover.trim()),
          showSource: base.doc.brand.showSource,
          hasLogo: Boolean(base.doc.brand.logoSrc),
        });
        const visuals: Visual[] = [];
        const errors = [...found.errors, ...stored.errors];
        let costUsd = 0;
        for (const a of stored.assets) {
          let framing = frameStill(null, zones);
          if (guard.enabled) {
            const r = await analyseAsset(a, pctx);
            costUsd += r.costUsd;
            if (r.error) errors.push(r.error);
            framing = frameStill(r.frame, zones);
            if (!framing.ok) continue;
          }
          // Other outlets' photos take the project's hand-drawn style, as in the build.
          visuals.push({ kind: "image", key: a.key, kenBurns: framing.kenBurns, focus: framing.focus, sketch: base.photoSketch === "off" ? null : { style: base.photoSketch }, credit: a.credit, assetId: a.assetId, thumbnailUrl: a.thumbnailUrl });
        }
        return { visuals: visuals.slice(0, keep), found: found.images.length, stored: stored.assets.length, errors, costUsd };
      });
      const missing = keep - related.visuals.length;

      /* ---- tier 3: stock for the rest; never for a political story ---- */
      const res =
        missing > 0 && stockAllowed && terms.length
          ? await step.run("broll", async () => {
              await reportProgress(pctx, { label: `Tìm B-roll mới cho cảnh ${scene.id}`, pct: 30 });
              // Skip clips this project already fetched for the scene so a retry brings something new.
              const seen = await withOrgContext(ctx, (tx) => tx.query.assets.findMany({ where: and(eq(schema.assets.projectId, projectId), eq(schema.assets.sceneId, scene.id)), columns: { provider: true, providerId: true } }));
              const exclude = new Set(seen.map((a) => `${a.provider}:${a.providerId}`));
              return fetchSceneBroll({ id: scene.id, voiceover: scene.voiceover, onScreenText: scene.onScreenText, brollTerms: terms }, { wantSec, buildId, keep: Math.max(2, missing), exclude }, pctx);
            })
          : null;
      const clips: Visual[] = res?.selected ? [res.selected, ...res.alternates].slice(0, missing).map((c) => ({ kind: "video" as const, key: c.key, clipDurationSec: c.durationSec ?? 5, trimStartSec: 0, credit: c.credit, assetId: c.assetId, thumbnailUrl: c.thumbnailUrl })) : [];

      /* ---- tier 4: AI stills when nothing else came up; never for a political story ---- */
      const generated =
        related.visuals.length + clips.length === 0 && tierAllowed("ai", base.political) && terms.length
          ? await step.run("ai-fallback", async () => {
              const a = await aiImagesAvailable(requestedBy);
              if (!a.enabled || !a.projectId) return { assets: [], errors: [a.reason ?? "AI tắt"], costUsd: 0 };
              await reportProgress(pctx, { label: `Không có stock, tạo ${Math.min(keep, a.remaining)} ảnh AI cho cảnh ${scene.id}`, pct: 45 });
              return generateSceneImages({ id: scene.id, onScreenText: scene.onScreenText, brollTerms: terms }, { count: Math.min(keep, a.remaining), buildId, language: base.doc.language, projectId: a.projectId }, pctx);
            })
          : null;
      const stills: Visual[] = (generated?.assets ?? []).map((a) => ({ kind: "image" as const, key: a.key, kenBurns: true, focus: null, sketch: null, credit: a.credit, assetId: a.assetId, thumbnailUrl: a.thumbnailUrl }));

      const fresh: Visual[] = [...related.visuals, ...clips, ...stills];
      if (!fresh.length) {
        const why = [related.errors[0] ? `báo khác: ${related.errors[0]}` : newsTerms.length ? `báo khác: không có ảnh dùng được cho “${newsTerms[0]}”` : null, res ? (res.errors[0] ?? (res.searched ? null : "chưa có key Pexels/Pixabay?")) : !stockAllowed ? "tin chính trị: không dùng stock / AI" : null, generated?.errors[0] ? `AI: ${generated.errors[0]}` : null].filter(Boolean);
        throw new NonRetriableError(`Không tìm được hình mới cho ${scene.id}${why.length ? `: ${why.join(" · ")}` : ""}`);
      }
      // New visuals take the first shots; keep the scene's remaining stills so the ≤ 5 s cadence holds.
      const keepStills = [scene.visual, ...scene.shots].filter((v) => v.kind === "image").slice(0, Math.max(0, keep - fresh.length));
      const all = [...fresh, ...keepStills];
      next = {
        ...base.doc,
        scenes: base.doc.scenes.map((s, i) => (i === sceneIdx ? { ...s, brollTerms: terms, visual: all[0], shots: all.slice(1) } : s)),
      };
      const parts = [
        related.visuals.length ? `${related.visuals.length} ảnh báo khác cho “${newsTerms[0]}”` : null,
        clips.length ? `${clips.length} clip stock (${res?.searched ?? 0} ứng viên, ${terms.join(", ")})` : null,
        stills.length ? `${stills.length} ảnh AI (Gemini) cho ${terms.join(", ")}` : null,
      ].filter(Boolean);
      changes.push(`${scene.id}: hình mới – ${parts.join(", ")}`);
      build.related = { sceneId: scene.id, query: newsTerms[0] ?? null, found: related.found, stored: related.stored, used: related.visuals.length, errors: related.errors, faceGuardCostUsd: related.costUsd };
      if (res) build.stock = { ...base.stock, [scene.id]: { selected: res.selected, alternates: res.alternates, searched: res.searched, errors: res.errors, rankCostUsd: res.rankCostUsd } };
      if (generated?.assets.length) build.ai = { sceneId: scene.id, assets: generated.assets.map((a) => ({ assetId: a.assetId, key: a.key })), errors: generated.errors, costUsd: generated.costUsd };
    }

    if (what === "motion" && scene) {
      const eng = engine ?? base.motionEngine;
      // The shot's place in the built timeline: its length and where the voice-over starts relative to its first frame.
      const { timeline } = buildFromDoc(base.doc, null);
      const tScene = timeline.scenes[sceneIdx];
      const shots = tScene.shots.length ? tScene.shots : [{ from: 0, durationFrames: tScene.durationFrames }];
      const whole = shot == null || shots.length === 1;
      const index = Math.min(shot ?? 0, shots.length - 1);
      const target = whole ? { from: 0, durationFrames: tScene.durationFrames } : shots[index];
      const durationSec = target.durationFrames / EDITOR_FPS;
      const voiceStartSec = (sceneIdx === 0 ? LEAD_MS / 1000 : 0) - target.from / EDITOR_FPS;
      // Pictures the graphic may use: the scene's own stills (at most 4), so a graphic can frame a real photo of the story.
      const stills = [scene.visual, ...scene.shots].flatMap((v) => (v.kind === "image" ? [v.key] : [])).filter((k, i, a) => a.indexOf(k) === i).slice(0, 4);
      // The clip or picture the editor chose to show behind the graphic: one of the scene's own (or a graphic's current
      // backdrop), else an asset of this project (the media library), never a foreign key.
      const clip = backdropPick
        ? await step.run("backdrop", async (): Promise<EditorBackdrop | null> => {
            const own = backdropCandidates(scene).find((b) => b.kind === backdropPick.kind && b.key === backdropPick.key && (b.kind === "image" || Math.abs(b.trimStartSec - backdropPick.trimStartSec) < 0.01));
            if (own) return own;
            const a = await withOrgContext(ctx, (tx) => tx.query.assets.findFirst({ where: and(eq(schema.assets.projectId, projectId), eq(schema.assets.r2Path, backdropPick.key)) }));
            if (!a) return null;
            const isImage = (a.mime ?? "").startsWith("image/") || a.origin === "article";
            if (isImage !== (backdropPick.kind === "image")) return null;
            const meta = { credit: a.attribution, assetId: a.id, thumbnailUrl: a.thumbnailUrl };
            if (!isImage) return { kind: "video", key: a.r2Path, clipDurationSec: a.durationSec ? Number(a.durationSec) : 5, trimStartSec: backdropPick.trimStartSec, ...meta };
            // A picture is cropped on its faces like a picture shot would be, under this scene's overlays.
            const frame = storedFrame(a.meta);
            const zones = overlayZones({ kind: scene.kind, headline: scene.onScreenText, caption: base.doc.brand.caption, headlineStyle: base.doc.brand.headline, hasCaptions: Boolean(scene.voiceover.trim()), showSource: base.doc.brand.showSource, hasLogo: Boolean(base.doc.brand.logoSrc) });
            return { kind: "image", key: a.r2Path, focus: frame ? frameStill(frame, zones).focus : null, ...meta };
          })
        : null;
      const r = await step.run("motion", async () => {
        await reportProgress(pctx, { label: `Claude Opus 5.5 dựng đồ hoạ chuyển động cho ${scene.id}${whole ? "" : ` · cảnh quay ${index + 1}`} (${eng === "hyperframes" ? "HyperFrames" : "Remotion"})`, pct: 20 });
        const images = await Promise.all(stills.map(async (key) => ({ key, url: await presignGet(key, 3600) })));
        try {
          return await designMotionShot(
            {
              engine: eng,
              language: base.doc.language,
              title: base.doc.title,
              sourceName: base.sourceName,
              brand: base.doc.brand,
              scene: { id: scene.id, kind: scene.kind, onScreenText: scene.onScreenText, voiceover: scene.voiceover },
              words: shotWords(scene.voice?.words ?? [], voiceStartSec, durationSec),
              durationSec,
              part: whole ? null : { index: index + 1, count: shots.length },
              images,
              backdrop: clip
                ? { ...clip, description: clip.kind === "video" ? `${clip.clipDurationSec.toFixed(0)} s of real footage chosen by the editor${clip.credit ? ` (${clip.credit})` : ""}` : `a photo chosen by the editor, shown full frame and dimmed${clip.credit ? ` (${clip.credit})` : ""}`, required: true }
                : null,
              instruction: instruction ?? null,
            },
            pctx,
          );
        } catch (e) {
          // Refusals, unusable output, billing / auth / bad requests do not fix themselves: fail with the reason for the editor.
          if (e instanceof LlmOutputError || isPermanentLlmError(e)) throw new NonRetriableError(e instanceof Error ? e.message : String(e));
          throw e;
        }
      });
      const visual = r.visual as EditorScene["visual"];
      next = {
        ...base.doc,
        scenes: base.doc.scenes.map((s, i) => (i !== sceneIdx ? s : whole ? { ...s, visual, shots: [] } : setShot(s, index, visual))),
      };
      changes.push(`${scene.id}: đồ hoạ chuyển động ${eng === "hyperframes" ? "HyperFrames" : "Remotion"}${whole ? " cho cả cảnh" : ` ở cảnh quay ${index + 1}`}${instruction ? ` (“${instruction.slice(0, 60)}${instruction.length > 60 ? "…" : ""}”)` : ""}`);
      build.motion = { sceneId: scene.id, shot: whole ? null : index, engine: eng, model: r.model, attempts: r.attempts, latencyMs: r.latencyMs, costUsd: r.costUsd, instruction: instruction ?? null, backdrop: clip?.key ?? null };
    }

    if (what === "music") {
      const music = await step.run("music", async () => {
        await reportProgress(pctx, { label: "Chọn nhạc mới", pct: 20 });
        const { durationSec } = voicePlacement(base.doc);
        return pickMusic({ tone: base.tone, durationSec, r2Key: r2Key.media(organizationId, projectId, `music/${buildId}.mp3`) }, pctx);
      });
      if (!music.pick) throw new NonRetriableError(music.error ? `Mubert lỗi và thư viện trống: ${music.error}` : "Thư viện nhạc trống và Mubert chưa bật");
      next = { ...base.doc, music: { key: music.pick.key, gainDb: base.doc.music?.gainDb ?? -12, attribution: music.pick.attribution, title: music.pick.title, source: music.pick.source, licence: music.pick.licence } };
      changes.push(`Nhạc mới: ${music.pick.title} (${music.pick.source})`);
      build.music = { source: music.pick.source, title: music.pick.title, licence: music.pick.licence, key: music.pick.key };
      build.musicError = music.error;
    }

    const saved = await step.run("save-version", async () => {
      await reportProgress(pctx, { label: "Trộn âm lại và lưu phiên bản mới", pct: 75 });
      return saveTimelineVersion({ ws: ctx, projectId, doc: next, baseVersion: base.version, kind: "regenerated", changes, build });
    });
    // The voice the editor picked is the project's from now on (single-scene re-voices and rebuilds read it), once its version exists.
    if (what === "voices" && voicePresetId !== undefined && voicePresetId !== base.voicePresetId) {
      await step.run("project-voice", async () => {
        await withOrgContext(ctx, (tx) => tx.update(schema.projects).set({ voicePresetId }).where(eq(schema.projects.id, projectId)));
        await logActivity({ actorId: requestedBy, organizationId, projectId, type: "project.voice_changed", payload: { from: base.voicePresetId, to: voicePresetId, timelineVersion: saved.version } });
      });
    }
    return { timelineId: saved.id, version: saved.version, changes: saved.changes };
  },
);
