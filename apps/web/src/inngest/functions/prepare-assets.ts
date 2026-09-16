import { NonRetriableError } from "inngest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inngest } from "../client";
import { projectAssetsRequested } from "../events";
import { autoAfterAssets } from "../auto-pipeline";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import type { StoredScript } from "@/lib/llm/schemas";
import { loadBrand } from "@/lib/media/brand";
import { fetchSceneBroll, type ChosenAsset, type SceneStock } from "@/lib/media/broll";
import { audioSignature, buildFromDoc, editorDocSchema, type EditorDoc, type EditorScene } from "@/lib/media/editor";
import { pickMusic } from "@/lib/media/music";
import { mixDocAudio } from "@/lib/media/remix";
import { downloadToR2, stockProvidersAvailable } from "@/lib/media/stock";
import { sceneTimings } from "@/lib/media/timeline";
import { loadPronunciations, loadVoicePreset, synthesizeScene, type SceneVoice } from "@/lib/media/tts";
import { deleteObject, r2Key } from "@/lib/r2";

const ext = (url: string, fallback: string) => {
  const m = /\.(jpe?g|png|webp|mp4|mov)(?:$|\?)/i.exec(url);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallback;
};

/**
 * Pipeline steps 3–6 (docs/PLAN.md §4): assets (article A-roll + stock B-roll,
 * ranked by Haiku, deduped org-wide), TTS with word timings and pronunciations,
 * music, media-Lambda audio mix, then a new timeline version. The project moves
 * to `composed`; re-running creates the next version and leaves old assets.
 */
export const prepareAssetsFn = inngest.createFunction(
  {
    id: "prepare-assets",
    triggers: [projectAssetsRequested],
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.projectId" }, { limit: 4 }],
    onFailure: async ({ event }) => {
      const { projectId, organizationId, requestedBy } = event.data.event.data;
      const message = event.data.error?.message ?? "asset preparation failed";
      await withOrgContext({ userId: requestedBy, organizationId }, (tx) =>
        tx.update(schema.projects).set({ busyStep: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "assets.failed", payload: { error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, scriptId, skipStock } = event.data;
    const ctx = { userId: requestedBy, organizationId };
    const pctx = { ...ctx, projectId };

    const input = await step.run("load", async () => {
      const row = await withOrgContext(ctx, async (tx) => {
        const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
        if (!project) throw new NonRetriableError("Project not found in this workspace");
        const script = scriptId
          ? await tx.query.scripts.findFirst({ where: and(eq(schema.scripts.projectId, projectId), eq(schema.scripts.id, scriptId)) })
          : await tx.query.scripts.findFirst({ where: eq(schema.scripts.projectId, projectId), orderBy: desc(schema.scripts.version) });
        if (!script) throw new NonRetriableError("Generate a script first");
        const article = await tx.query.articles.findFirst({ where: eq(schema.articles.projectId, projectId), orderBy: desc(schema.articles.createdAt) });
        await tx.update(schema.projects).set({ busyStep: "assets", lastError: null }).where(eq(schema.projects.id, projectId));
        return { project, script, article };
      });
      const s = row.script.scenesJson as unknown as StoredScript;
      return {
        buildId: nanoid(8),
        scriptId: row.script.id,
        scriptVersion: row.script.version,
        language: row.project.language,
        tone: row.project.tone,
        title: row.project.title ?? s.title,
        source: { name: row.article?.siteName ?? null, url: row.project.canonicalUrl ?? row.project.url },
        images: (row.article?.images ?? []).filter((im) => !/\.(gif|svg)(?:$|\?)/i.test(im.url) && (im.width ?? 1000) >= 600).slice(0, 4),
        scenes: s.scenes.map((sc) => ({ id: sc.id, kind: sc.kind, voiceover: sc.voiceover, onScreenText: sc.onScreenText, brollTerms: sc.brollTerms, durationSec: sc.durationSec })),
      };
    });
    const media = (name: string) => r2Key.media(organizationId, projectId, name);

    const brand = await step.run("brand", () => loadBrand(ctx));

    /* ---- voice-over per scene (parallel) ---- */
    const voiceSetup = await step.run("voice-setup", async () => ({
      preset: await loadVoicePreset(ctx, input.language),
      pronunciations: await loadPronunciations(ctx, input.language),
    }));
    const voices: SceneVoice[] = await Promise.all(
      input.scenes.map((sc) =>
        step.run(`voice-${sc.id}`, () =>
          synthesizeScene(
            { sceneId: sc.id, text: sc.voiceover, language: input.language, preset: voiceSetup.preset, pronunciations: voiceSetup.pronunciations, r2Key: media(`vo/${input.buildId}-${sc.id}.wav`) },
            pctx,
          ),
        ),
      ),
    );

    /* ---- article A-roll (images) ---- */
    const aroll = await step.run("aroll", async (): Promise<ChosenAsset[]> => {
      const out: ChosenAsset[] = [];
      for (const [i, im] of input.images.entries()) {
        try {
          const key = media(`aroll/${input.buildId}-${i}.${ext(im.url, "jpg")}`);
          const dl = await downloadToR2(im.url, key, "image/jpeg");
          if (!dl.contentType.startsWith("image/")) {
            await deleteObject(key).catch(() => {});
            continue;
          }
          const [row] = await withOrgContext(ctx, (tx) =>
            tx
              .insert(schema.assets)
              .values({ organizationId, projectId, origin: "article", provider: "article", sourceUrl: im.url, r2Path: key, hash: dl.hash, mime: dl.contentType, width: im.width ?? null, height: im.height ?? null, sizeBytes: dl.sizeBytes, licence: "source article", attribution: input.source.name ? `Ảnh: ${input.source.name}` : null, thumbnailUrl: im.url })
              .returning({ id: schema.assets.id }),
          );
          out.push({ assetId: row.id, key, kind: "image", durationSec: null, credit: input.source.name ? `Ảnh: ${input.source.name}` : null, provider: "article", thumbnailUrl: im.url });
        } catch (e) {
          console.warn("[assets] article image skipped", im.url, e);
        }
      }
      return out;
    });

    /* ---- stock B-roll per scene (parallel): search → rank thumbnails → download top 2 ---- */
    const providers = await step.run("stock-providers", () => stockProvidersAvailable());
    const stockEnabled = !skipStock && (providers.pexels || providers.pixabay);
    const stock: Record<string, SceneStock> = {};
    if (stockEnabled) {
      const results = await Promise.all(
        input.scenes
          .filter((sc) => sc.kind !== "cta" && sc.brollTerms.length)
          .map((sc) =>
            step.run(`stock-${sc.id}`, async (): Promise<[string, SceneStock]> => {
              const voice = voices.find((v) => v.sceneId === sc.id);
              const wantSec = (voice?.durationMs ?? sc.durationSec * 1000) / 1000;
              return [sc.id, await fetchSceneBroll(sc, { wantSec, buildId: input.buildId }, pctx)];
            }),
          ),
      );
      for (const [id, r] of results) stock[id] = r;
    }

    /* ---- music ---- */
    const preTiming = sceneTimings({ scenes: input.scenes.map((sc) => ({ ...sc, voice: voices.find((v) => v.sceneId === sc.id) ?? null, visual: null })) });
    const music = await step.run("music", () => pickMusic({ tone: input.tone, durationSec: preTiming.durationSec, r2Key: media(`music/${input.buildId}.mp3`) }, pctx));

    /* ---- editor document (docs/PLAN.md §4.7): the source every later version is rebuilt from ---- */
    const doc: EditorDoc = await step.run("compose-doc", async () => {
      let imageIdx = 0;
      const nextImage = (): EditorScene["visual"] => {
        if (!aroll.length) return { kind: "solid" };
        const im = aroll[imageIdx % aroll.length];
        imageIdx += 1;
        return { kind: "image", key: im.key, kenBurns: true, credit: im.credit, assetId: im.assetId, thumbnailUrl: im.thumbnailUrl };
      };
      const scenes: EditorScene[] = input.scenes.map((sc) => {
        const v = voices.find((x) => x.sceneId === sc.id) ?? null;
        const st = stock[sc.id]?.selected ?? null;
        const visual: EditorScene["visual"] = st
          ? { kind: "video", key: st.key, clipDurationSec: st.durationSec ?? 5, trimStartSec: 0, credit: st.credit, assetId: st.assetId, thumbnailUrl: st.thumbnailUrl }
          : nextImage();
        return {
          id: sc.id,
          kind: sc.kind,
          onScreenText: sc.onScreenText,
          voiceover: v?.spokenText ?? sc.voiceover,
          brollTerms: sc.brollTerms,
          durationSec: sc.durationSec,
          voice: v ? { key: v.key, durationMs: v.durationMs, words: v.words } : null,
          visual,
          holdMs: 0,
          captions: null,
        };
      });
      return editorDocSchema.parse({
        v: 1,
        title: input.title,
        language: input.language,
        source: input.source,
        brand: brand.brand,
        scenes,
        music: music.pick ? { key: music.pick.key, gainDb: -12, attribution: music.pick.attribution, title: music.pick.title, source: music.pick.source, licence: music.pick.licence } : null,
        coverAtSec: null,
      });
    });

    /* ---- audio mix (media Lambda) ---- */
    const mix = await step.run("mix", () => mixDocAudio(doc, pctx, input.buildId));

    /* ---- timeline version ---- */
    const stored = await step.run("store-timeline", async () => {
      const { timeline, durationSec } = buildFromDoc(doc, { mixKey: mix.mixKey, voiceKey: mix.voiceKey });
      const buildJson = {
        buildId: input.buildId,
        scriptVersion: input.scriptVersion,
        voice: { preset: voiceSetup.preset.voice, scenes: voices.map((v) => ({ sceneId: v.sceneId, key: v.key, durationMs: v.durationMs, timing: v.timing, matched: v.matched, words: v.words.length, chars: v.chars, spokenText: v.spokenText, pronunciations: v.pronunciationsApplied, costUsd: v.costUsd })) },
        stock: Object.fromEntries(Object.entries(stock).map(([id, s]) => [id, { selected: s.selected, alternates: s.alternates, searched: s.searched, errors: s.errors, rankCostUsd: s.rankCostUsd }])),
        stockEnabled,
        aroll: aroll.map((a) => ({ assetId: a.assetId, key: a.key })),
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
        const selectedIds = Object.values(stock).flatMap((s) => (s.selected ? [s.selected.assetId] : []));
        if (selectedIds.length) await tx.update(schema.assets).set({ selected: true }).where(inArray(schema.assets.id, selectedIds));
        // A rebuild supersedes any approval of the previous version.
        await tx.update(schema.projects).set({ state: "composed", busyStep: null, lastError: null, approvedTimelineId: null, approvedBy: null, approvedAt: null }).where(eq(schema.projects.id, projectId));
        return t;
      });
      const costUsd = voices.reduce((a, v) => a + v.costUsd, 0) + Object.values(stock).reduce((a, s) => a + s.rankCostUsd, 0) + mix.costUsd;
      await logActivity({
        actorId: requestedBy, organizationId, projectId, type: "timeline.built",
        payload: { timelineId: row.id, version: row.version, durationSec, scenes: doc.scenes.length, stockScenes: Object.values(stock).filter((s) => s.selected).length, imageScenes: doc.scenes.filter((s) => s.visual.kind === "image").length, music: music.pick?.source ?? null, timing: voices.map((v) => v.timing), costUsd: Math.round(costUsd * 1e4) / 1e4 },
      });
      return { ...row, durationSec };
    });

    const next = await step.run("auto-continue", () => autoAfterAssets(ctx, projectId, stored.id, stored.durationSec));
    if (next) await step.sendEvent("auto-render", next);

    return { timelineId: stored.id, version: stored.version, durationSec: stored.durationSec, auto: Boolean(next) };
  },
);
