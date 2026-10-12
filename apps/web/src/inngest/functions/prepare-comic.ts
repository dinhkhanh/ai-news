import { NonRetriableError } from "inngest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inngest } from "../client";
import { projectComicBuildRequested } from "../events";
import { autoAfterAssets } from "../auto-pipeline";
import { reportProgress, tickProgress } from "@/lib/progress";
import { eventSuperseded } from "@/lib/project-state";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { imageModel } from "@/lib/comic/models";
import type { ComicScript, ComicSceneMeta } from "@/lib/comic/motion";
import { composeComicDoc } from "@/lib/comic/motion-doc";
import { loadBrand } from "@/lib/media/brand";
import { audioSignature, buildFromDoc, type EditorDoc } from "@/lib/media/editor";
import { pickMusic } from "@/lib/media/music";
import { mixDocAudio } from "@/lib/media/remix";
import { sceneTimings } from "@/lib/media/timeline";
import { loadPronunciations, loadVoicePreset, synthesizeScene, type SceneVoice, type VoicePreset } from "@/lib/media/tts";
import { copyObject, r2Key } from "@/lib/r2";

/** Comic panels are our own pictures drawn by an image model: the shot credit names it. */
const creditFor = (model: string | null) => `Minh hoạ AI (${model ? (imageModel(model)?.provider === "openai" ? "GPT Image" : "Gemini") : "Gemini"})`;

/**
 * Motion comic build (docs/COMIC.md §11.1, M4), forwarded by `prepare-assets` for a `comic` project. The script
 * was built from the comic without a model call (`comic/motion.ts`); every scene is one lettering beat over its
 * panel. Here: a voice per beat (the speaker's character voice, `comic_characters.voice_preset_id`, else the
 * project's narrator voice; silent beats have none), the panels copied into the project's media as `assets` rows
 * (provider `comic`, so the editor can swap between them and deleting the comic leaves the video intact), each
 * panel framed on the speaker's face with the face guard (`frameStill`), music unless turned off, the media-Lambda
 * mix and a new timeline version. A picture shown for several beats and a picture held longer than 5 s are the
 * point of a motion comic, so the stock / AI tiers, the originality limits and the shot cadence do not apply.
 */
export const prepareComicFn = inngest.createFunction(
  {
    id: "prepare-comic",
    triggers: [projectComicBuildRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 4 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "motion comic build failed";
      await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
        tx.update(schema.projects).set({ busyStep: null, busyProgress: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "assets.failed", payload: { error: message.slice(0, 500), comic: true } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, scriptId } = event.data;
    const ctx = { userId: requestedBy, organizationId };
    const pctx = { ...ctx, projectId };
    const media = (name: string) => r2Key.media(organizationId, projectId, name);

    const input = await step.run("load", async () => {
      const row = await withOrgContext(ctx, async (tx) => {
        const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
        if (!project) throw new NonRetriableError("Project not found in this workspace");
        const built = await tx.query.timelines.findFirst({ where: and(eq(schema.timelines.projectId, projectId), eq(schema.timelines.kind, "built")), orderBy: desc(schema.timelines.createdAt), columns: { createdAt: true } });
        if (eventSuperseded(event.ts, { latestResultAt: built?.createdAt })) return null;
        const script = scriptId
          ? await tx.query.scripts.findFirst({ where: and(eq(schema.scripts.projectId, projectId), eq(schema.scripts.id, scriptId)) })
          : await tx.query.scripts.findFirst({ where: eq(schema.scripts.projectId, projectId), orderBy: desc(schema.scripts.version) });
        if (!script) throw new NonRetriableError("The motion comic has no script: make the video from the comic again");
        const s = script.scenesJson as unknown as ComicScript;
        if (!s.comic) throw new NonRetriableError("This script was not made from a comic");
        const characterIds = [...new Set(Object.values(s.comic.scenes).flatMap((m) => (m.reader?.kind === "character" && m.reader.characterId ? [m.reader.characterId] : [])))];
        const characters = characterIds.length
          ? await tx.select({ id: schema.comicCharacters.id, voicePresetId: schema.comicCharacters.voicePresetId }).from(schema.comicCharacters).where(and(inArray(schema.comicCharacters.id, characterIds), eq(schema.comicCharacters.organizationId, organizationId)))
          : [];
        await tx.update(schema.projects).set({ busyStep: "assets", lastError: null }).where(eq(schema.projects.id, projectId));
        return { project, script, s, characters };
      });
      if (!row) return null;
      await reportProgress(pctx, { label: "Đọc kịch bản truyện", pct: 2 });
      return {
        buildId: nanoid(8),
        scriptId: row.script.id,
        scriptVersion: row.script.version,
        language: row.project.language,
        tone: row.project.tone,
        voicePresetId: row.project.voicePresetId,
        brandKitId: row.project.brandKitId,
        hasChannelLogo: Boolean(row.project.logoChannelId),
        title: row.project.title ?? row.s.title,
        comic: row.s.comic,
        /** Character id → its voice (null = the narrator's). */
        characterVoices: Object.fromEntries(row.characters.map((c) => [c.id, c.voicePresetId])) as Record<string, string | null>,
        scenes: row.s.scenes.map((sc) => ({ id: sc.id, kind: sc.kind, voiceover: sc.voiceover, onScreenText: sc.onScreenText, durationSec: sc.durationSec })),
      };
    });
    if (!input) return { projectId, skipped: "superseded" as const };
    const metaOf = (id: string): ComicSceneMeta => {
      const m = input.comic.scenes[id];
      if (!m) throw new NonRetriableError(`Scene ${id} has no panel`);
      return m;
    };
    const voiceIdOf = (id: string) => {
      const r = metaOf(id).reader;
      return r?.kind === "character" && r.characterId ? (input.characterVoices[r.characterId] ?? null) : null;
    };

    const brand = await step.run("brand", () => loadBrand(ctx, input.brandKitId));

    /* ---- voices: the narrator's (project voice) and each character's own, then one recording per spoken beat ---- */
    const spoken = input.scenes.filter((sc) => sc.voiceover.trim());
    const voiceSetup = await step.run("voice-setup", async () => {
      await reportProgress(pctx, { label: `Tổng hợp giọng đọc (${spoken.length} lời)`, pct: 5, total: spoken.length });
      const narrator = await loadVoicePreset(ctx, input.language, input.voicePresetId);
      const ids = [...new Set(spoken.map((sc) => voiceIdOf(sc.id)).filter((v): v is string => Boolean(v)))];
      const presets: Record<string, VoicePreset> = {};
      // A character voice that cannot read the comic's language falls back to the workspace default (`pickVoice`).
      for (const id of ids) presets[id] = await loadVoicePreset(ctx, input.language, id);
      return { narrator, presets, pronunciations: await loadPronunciations(ctx, input.language) };
    });
    const voices: SceneVoice[] = await Promise.all(
      spoken.map((sc) =>
        step.run(`voice-${sc.id}`, async () => {
          const id = voiceIdOf(sc.id);
          const v = await synthesizeScene(
            { sceneId: sc.id, text: sc.voiceover, language: input.language, preset: (id && voiceSetup.presets[id]) || voiceSetup.narrator, pronunciations: voiceSetup.pronunciations, r2Key: media(`vo/${input.buildId}-${sc.id}.wav`) },
            pctx,
          );
          await tickProgress(pctx, { label: "Giọng đọc", total: spoken.length, from: 5, to: 60 });
          return v;
        }),
      ),
    );

    /* ---- panels → project media + assets rows (once per picture; a rebuild reuses them) ---- */
    const panels = await step.run("panels", async () => {
      await reportProgress(pctx, { label: "Chép các khung truyện vào dự án", pct: 62 });
      const pictures = new Map(Object.values(input.comic.scenes).map((m) => [m.imageId, m]));
      const ids = [...pictures.keys()];
      return withOrgContext(ctx, async (tx) => {
        const have = await tx
          .select({ id: schema.assets.id, providerId: schema.assets.providerId, key: schema.assets.r2Path, credit: schema.assets.attribution })
          .from(schema.assets)
          .where(and(eq(schema.assets.projectId, projectId), eq(schema.assets.provider, "comic"), inArray(schema.assets.providerId, ids)));
        const out: Record<string, { assetId: string; key: string; credit: string }> = Object.fromEntries(have.map((a) => [a.providerId!, { assetId: a.id, key: a.key, credit: a.credit ?? creditFor(null) }]));
        const missing = ids.filter((id) => !out[id]);
        if (!missing.length) return out;
        const images = await tx.select({ id: schema.comicImages.id, model: schema.comicImages.model }).from(schema.comicImages).where(inArray(schema.comicImages.id, missing));
        const models = new Map(images.map((i) => [i.id, i.model]));
        for (const id of missing) {
          const m = pictures.get(id)!;
          const ext = /\.(png|jpe?g|webp)$/i.exec(m.key)?.[1].toLowerCase().replace("jpeg", "jpg") ?? "png";
          const key = media(`comic/${id}.${ext}`);
          try {
            await copyObject(m.key, key);
          } catch (e) {
            throw new NonRetriableError(`Không chép được khung ${m.panelId} (trang ${m.page}): ${(e as Error).message}`);
          }
          const credit = creditFor(models.get(id) ?? null);
          const [row] = await tx
            .insert(schema.assets)
            .values({
              organizationId, projectId, origin: "upload", provider: "comic", providerId: id, r2Path: key, mime: ext === "jpg" ? "image/jpeg" : `image/${ext}`, width: m.width, height: m.height, attribution: credit, licence: "own",
              // `frame`: the faces found when the panel was drawn, so the editor's face guard and "Căn khung tự động" work on it.
              meta: { comicId: input.comic.comicId, panelId: m.panelId, page: m.page, frame: { width: m.width, height: m.height, faces: m.faces.map((f) => ({ ...f, confidence: 1 })) } },
            })
            .returning({ id: schema.assets.id });
          out[id] = { assetId: row.id, key, credit };
        }
        return out;
      });
    });

    /* ---- music ---- */
    const preTiming = sceneTimings({ scenes: input.scenes.map((sc) => ({ ...sc, voice: voices.find((v) => v.sceneId === sc.id) ?? null, visual: null })) });
    const music = await step.run("music", async () => {
      if (!input.comic.music) return { pick: null, error: null };
      await reportProgress(pctx, { label: "Chọn nhạc nền", pct: 70 });
      return pickMusic({ tone: input.tone, durationSec: preTiming.durationSec, r2Key: media(`music/${input.buildId}.mp3`) }, pctx);
    });

    /* ---- editor document: one shot per beat, the panel framed on whoever speaks (`motion-doc.ts`) ---- */
    const doc: EditorDoc = await step.run("compose-doc", async () => {
      await reportProgress(pctx, { label: "Ghép cảnh theo từng lời thoại", pct: 78 });
      return composeComicDoc({ title: input.title, language: input.language, comic: input.comic, scenes: input.scenes, brand: brand.brand, hasChannelLogo: input.hasChannelLogo, voices, panels, music: music.pick });
    });

    const mix = await step.run("mix", async () => {
      await reportProgress(pctx, { label: "Trộn âm −16 LUFS (media Lambda)", pct: 85 });
      return mixDocAudio(doc, pctx, input.buildId);
    });

    const stored = await step.run("store-timeline", async () => {
      await reportProgress(pctx, { label: "Lưu timeline", pct: 95 });
      const { timeline, durationSec } = buildFromDoc(doc, { mixKey: mix.mixKey, voiceKey: mix.voiceKey });
      const presetOf = (id: string) => voiceIdOf(id) ?? null;
      const buildJson = {
        buildId: input.buildId,
        scriptVersion: input.scriptVersion,
        voice: {
          preset: voiceSetup.narrator.voice,
          presetId: voiceSetup.narrator.id,
          presetName: voiceSetup.narrator.name,
          model: voiceSetup.narrator.model,
          characters: Object.fromEntries(Object.entries(voiceSetup.presets).map(([id, p]) => [id, { voice: p.voice, name: p.name }])),
          scenes: voices.map((v) => ({ sceneId: v.sceneId, key: v.key, durationMs: v.durationMs, timing: v.timing, matched: v.matched, words: v.words.length, chars: v.chars, spokenText: v.spokenText, pronunciations: v.pronunciationsApplied, costUsd: v.costUsd, presetId: presetOf(v.sceneId) })),
        },
        /** Motion comic: what the video was made from and how each beat was framed. */
        comic: {
          comicId: input.comic.comicId,
          versionId: input.comic.versionId,
          pages: input.comic.pages,
          episode: input.comic.episode,
          panels: Object.keys(panels).length,
          silent: input.scenes.length - spoken.length,
          framed: doc.scenes.filter((s) => s.visual.kind === "image" && s.visual.focus).length,
        },
        music: music.pick ? { source: music.pick.source, title: music.pick.title, licence: music.pick.licence, key: music.pick.key } : null,
        musicError: music.error,
        mix: { mixKey: mix.mixKey, voiceKey: mix.voiceKey, integratedLufs: mix.integratedLufs, signature: audioSignature(doc), reused: false },
        brandKitId: brand.id,
        doc,
      };
      const row = await withOrgContext(ctx, async (tx) => {
        const latest = await tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, projectId), orderBy: desc(schema.timelines.version) });
        const [t] = await tx
          .insert(schema.timelines)
          .values({ organizationId, projectId, version: (latest?.version ?? 0) + 1, json: timeline as unknown as Record<string, unknown>, scriptId: input.scriptId, durationSec: durationSec.toFixed(2), buildJson, kind: "built", changes: latest ? [`Dựng lại từ kịch bản v${input.scriptVersion}`] : [], createdBy: requestedBy })
          .returning({ id: schema.timelines.id, version: schema.timelines.version });
        // The pictures are AI drawings: the publish-time disclosure is on.
        await tx
          .update(schema.projects)
          .set({ state: "composed", busyStep: null, busyProgress: null, lastError: null, approvedTimelineId: null, approvedBy: null, approvedAt: null, aiDisclosure: true })
          .where(eq(schema.projects.id, projectId));
        return t;
      });
      const costUsd = voices.reduce((a, v) => a + v.costUsd, 0) + mix.costUsd;
      await logActivity({
        actorId: requestedBy, organizationId, projectId, type: "timeline.built",
        payload: { timelineId: row.id, version: row.version, durationSec, scenes: doc.scenes.length, comic: true, comicId: input.comic.comicId, comicVersionId: input.comic.versionId, panels: Object.keys(panels).length, characterVoices: Object.keys(voiceSetup.presets).length, music: music.pick?.source ?? null, timing: voices.map((v) => v.timing), costUsd: Math.round(costUsd * 1e4) / 1e4 },
      });
      return { ...row, durationSec };
    });

    const next = await step.run("auto-continue", () => autoAfterAssets(ctx, projectId, stored.id, stored.durationSec));
    if (next) await step.sendEvent("auto-render", next);

    return { timelineId: stored.id, version: stored.version, durationSec: stored.durationSec, auto: Boolean(next) };
  },
);
