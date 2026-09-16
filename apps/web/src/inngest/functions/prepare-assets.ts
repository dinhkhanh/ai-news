import { NonRetriableError } from "inngest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inngest } from "../client";
import { projectAssetsRequested } from "../events";
import { autoAfterAssets } from "../auto-pipeline";
import { reportProgress, tickProgress } from "@/lib/progress";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import type { StoredScript } from "@/lib/llm/schemas";
import { loadBrand } from "@/lib/media/brand";
import { fetchSceneBroll, type ChosenAsset, type SceneStock } from "@/lib/media/broll";
import { audioSignature, buildFromDoc, editorDocSchema, type EditorDoc, type EditorScene } from "@/lib/media/editor";
import { pickMusic } from "@/lib/media/music";
import { assignImages } from "@/lib/media/rank";
import { findRelatedImages, storeRelatedImages } from "@/lib/media/related";
import { mixDocAudio } from "@/lib/media/remix";
import { downloadToR2, stockProvidersAvailable } from "@/lib/media/stock";
import { sceneTimings, shotsNeeded } from "@/lib/media/timeline";
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
 *
 * Every scene is cut into shots so the picture changes at least every 5 s
 * (`shotsNeeded`), and no visual is used twice in the video. When the article's
 * own images plus stock clips cannot cover the budget, images from other
 * outlets' coverage of the same story are fetched (`findRelatedImages`).
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
        tx.update(schema.projects).set({ busyStep: null, busyProgress: null, lastError: message.slice(0, 2000) }).where(eq(schema.projects.id, projectId)),
      );
      await logActivity({ actorId: requestedBy, organizationId, projectId, type: "assets.failed", payload: { error: message.slice(0, 500) } });
    },
  },
  async ({ event, step }) => {
    const { projectId, organizationId, requestedBy, scriptId, skipStock } = event.data;
    const ctx = { userId: requestedBy, organizationId };
    const pctx = { ...ctx, projectId };

    const input = await step.run("load", async () => {
      await reportProgress(pctx, { label: "Đọc kịch bản", pct: 2 });
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
        articleTitle: row.article?.title ?? row.project.title ?? s.title,
        source: { name: row.article?.siteName ?? null, url: row.project.canonicalUrl ?? row.project.url },
        images: (row.article?.images ?? []).filter((im) => !/\.(gif|svg)(?:$|\?)/i.test(im.url) && (im.width ?? 1000) >= 600).slice(0, 12),
        scenes: s.scenes.map((sc) => ({ id: sc.id, kind: sc.kind, voiceover: sc.voiceover, onScreenText: sc.onScreenText, brollTerms: sc.brollTerms, durationSec: sc.durationSec })),
      };
    });
    const media = (name: string) => r2Key.media(organizationId, projectId, name);

    const brand = await step.run("brand", () => loadBrand(ctx));

    /* ---- voice-over per scene (parallel) ---- */
    const voiceSetup = await step.run("voice-setup", async () => {
      await reportProgress(pctx, { label: `Tổng hợp giọng đọc (${input.scenes.length} cảnh)`, pct: 5, total: input.scenes.length });
      return {
        preset: await loadVoicePreset(ctx, input.language),
        pronunciations: await loadPronunciations(ctx, input.language),
      };
    });
    const voices: SceneVoice[] = await Promise.all(
      input.scenes.map((sc) =>
        step.run(`voice-${sc.id}`, async () => {
          const v = await synthesizeScene(
            { sceneId: sc.id, text: sc.voiceover, language: input.language, preset: voiceSetup.preset, pronunciations: voiceSetup.pronunciations, r2Key: media(`vo/${input.buildId}-${sc.id}.wav`) },
            pctx,
          );
          await tickProgress(pctx, { label: "Giọng đọc", total: input.scenes.length, from: 5, to: 28 });
          return v;
        }),
      ),
    );

    /* ---- article A-roll (images) ---- */
    const aroll = await step.run("aroll", async (): Promise<ChosenAsset[]> => {
      await reportProgress(pctx, { label: `Tải ảnh từ bài báo (${input.images.length})`, pct: 30 });
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

    /* ---- shot budget: one picture per ≤ 5 s of voice, one for the CTA ---- */
    const voiceMs = (id: string, fallbackSec: number) => voices.find((v) => v.sceneId === id)?.durationMs ?? fallbackSec * 1000;
    const need: Record<string, number> = Object.fromEntries(input.scenes.map((sc) => [sc.id, sc.kind === "cta" ? 1 : shotsNeeded(voiceMs(sc.id, sc.durationSec))]));

    /* ---- stock B-roll per scene (parallel): search → rank thumbnails → download as many clips as the scene needs ---- */
    const stockScenes = input.scenes.filter((sc) => sc.kind !== "cta" && sc.brollTerms.length);
    const providers = await step.run("stock-providers", async () => {
      const p = await stockProvidersAvailable();
      const on = !skipStock && (p.pexels || p.pixabay);
      await reportProgress(pctx, { label: on ? `Tìm B-roll Pexels/Pixabay, Haiku xếp hạng (${stockScenes.length} cảnh)` : "Bỏ qua stock B-roll", pct: 36, total: stockScenes.length });
      return p;
    });
    const stockEnabled = !skipStock && (providers.pexels || providers.pixabay);
    const stock: Record<string, SceneStock> = {};
    if (stockEnabled) {
      const results = await Promise.all(
        stockScenes.map((sc) =>
          step.run(`stock-${sc.id}`, async (): Promise<[string, SceneStock]> => {
            const wantSec = Math.min(5, voiceMs(sc.id, sc.durationSec) / 1000);
            const r = await fetchSceneBroll(sc, { wantSec, buildId: input.buildId, keep: need[sc.id] }, pctx);
            await tickProgress(pctx, { label: "B-roll cảnh", total: stockScenes.length, from: 36, to: 62 });
            return [sc.id, r];
          }),
        ),
      );
      for (const [id, r] of results) stock[id] = r;
    }

    /* ---- pictures still missing after stock: article images, then other outlets' coverage of the same story ---- */
    const stockCount = (id: string) => (stock[id] ? (stock[id].selected ? 1 : 0) + stock[id].alternates.length : 0);
    const imageDeficit = input.scenes.reduce((a, sc) => a + Math.max(0, need[sc.id] - stockCount(sc.id)), 0);
    const related = await step.run("related-aroll", async () => {
      const shortfall = imageDeficit - aroll.length;
      await reportProgress(pctx, { label: shortfall > 0 ? `Tìm thêm ${shortfall} ảnh từ báo khác cùng tin` : "Đủ ảnh, không cần tìm thêm", pct: 64 });
      if (shortfall <= 0) return { assets: [] as ChosenAsset[], pages: 0, found: 0, errors: [] as string[], shortfall };
      const found = await findRelatedImages({ query: input.articleTitle, language: input.language, excludeUrls: [input.source.url], want: shortfall });
      const stored = await storeRelatedImages(found.images, { buildId: input.buildId, max: shortfall + 2 }, pctx);
      return { assets: stored.assets, pages: found.pages, found: found.images.length, errors: [...found.errors, ...stored.errors], shortfall };
    });
    const imagePool: ChosenAsset[] = [...aroll, ...related.assets];

    /* ---- which image goes to which scene: Haiku matches subjects; every image at most once ---- */
    const assignment = await step.run("assign-images", async () => {
      await reportProgress(pctx, { label: "Xếp ảnh vào cảnh (Haiku)", pct: 72 });
      const wanting = input.scenes.map((sc) => ({ id: sc.id, voiceover: sc.voiceover, onScreenText: sc.onScreenText, want: Math.max(0, need[sc.id] - stockCount(sc.id)) })).filter((s) => s.want > 0);
      let picks: Record<string, number[]> = {};
      let costUsd = 0;
      let method: "haiku" | "sequential" = "sequential";
      if (wanting.length && imagePool.length) {
        try {
          const r = await assignImages(wanting, imagePool.map((a) => ({ key: a.key, thumbnailUrl: a.thumbnailUrl ?? "", hint: a.provider === "related" ? "other outlet" : "source article" })).filter((c) => c.thumbnailUrl), pctx);
          picks = Object.fromEntries(r.picks);
          costUsd = r.costUsd;
          method = "haiku";
        } catch (e) {
          console.warn("[assets] image assignment failed, assigning in order", e);
        }
      }
      // Greedy: ranked picks first, then whatever is left in pool order. Never the same image twice.
      const used = new Set<number>();
      const perScene: Record<string, number[]> = {};
      for (const w of wanting) {
        const chosen: number[] = [];
        for (const i of picks[w.id] ?? []) {
          if (chosen.length >= w.want || used.has(i)) continue;
          used.add(i);
          chosen.push(i);
        }
        perScene[w.id] = chosen;
      }
      for (const w of wanting) {
        const chosen = perScene[w.id];
        for (let i = 0; i < imagePool.length && chosen.length < w.want; i++) {
          if (used.has(i)) continue;
          used.add(i);
          chosen.push(i);
        }
      }
      return { perScene, method, costUsd, unused: imagePool.length - used.size };
    });

    /* ---- music ---- */
    const preTiming = sceneTimings({ scenes: input.scenes.map((sc) => ({ ...sc, voice: voices.find((v) => v.sceneId === sc.id) ?? null, visual: null })) });
    const music = await step.run("music", async () => {
      await reportProgress(pctx, { label: "Chọn nhạc nền", pct: 78 });
      return pickMusic({ tone: input.tone, durationSec: preTiming.durationSec, r2Key: media(`music/${input.buildId}.mp3`) }, pctx);
    });

    /* ---- editor document (docs/PLAN.md §4.7): the source every later version is rebuilt from ---- */
    const doc: EditorDoc = await step.run("compose-doc", async () => {
      await reportProgress(pctx, { label: "Ghép cảnh, chia shot ≤ 5 giây", pct: 82 });
      const clip = (st: ChosenAsset): EditorScene["visual"] => ({ kind: "video", key: st.key, clipDurationSec: st.durationSec ?? 5, trimStartSec: 0, credit: st.credit, assetId: st.assetId, thumbnailUrl: st.thumbnailUrl });
      const still = (im: ChosenAsset): EditorScene["visual"] => ({ kind: "image", key: im.key, kenBurns: true, credit: im.credit, assetId: im.assetId, thumbnailUrl: im.thumbnailUrl });
      const scenes: EditorScene[] = input.scenes.map((sc) => {
        const v = voices.find((x) => x.sceneId === sc.id) ?? null;
        const s = stock[sc.id];
        const clips = s ? [...(s.selected ? [s.selected] : []), ...s.alternates].slice(0, need[sc.id]).map(clip) : [];
        const stills = (assignment.perScene[sc.id] ?? []).map((i) => still(imagePool[i]));
        const all = [...clips, ...stills];
        const visual: EditorScene["visual"] = all[0] ?? { kind: "solid" };
        return {
          id: sc.id,
          kind: sc.kind,
          onScreenText: sc.onScreenText,
          voiceover: v?.spokenText ?? sc.voiceover,
          brollTerms: sc.brollTerms,
          durationSec: sc.durationSec,
          voice: v ? { key: v.key, durationMs: v.durationMs, words: v.words } : null,
          visual,
          shots: all.slice(1),
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
    const mix = await step.run("mix", async () => {
      await reportProgress(pctx, { label: "Trộn âm −16 LUFS (media Lambda)", pct: 85 });
      return mixDocAudio(doc, pctx, input.buildId);
    });

    /* ---- timeline version ---- */
    const stored = await step.run("store-timeline", async () => {
      await reportProgress(pctx, { label: "Lưu timeline", pct: 95 });
      const { timeline, durationSec } = buildFromDoc(doc, { mixKey: mix.mixKey, voiceKey: mix.voiceKey });
      const buildJson = {
        buildId: input.buildId,
        scriptVersion: input.scriptVersion,
        voice: { preset: voiceSetup.preset.voice, scenes: voices.map((v) => ({ sceneId: v.sceneId, key: v.key, durationMs: v.durationMs, timing: v.timing, matched: v.matched, words: v.words.length, chars: v.chars, spokenText: v.spokenText, pronunciations: v.pronunciationsApplied, costUsd: v.costUsd })) },
        stock: Object.fromEntries(Object.entries(stock).map(([id, s]) => [id, { selected: s.selected, alternates: s.alternates, searched: s.searched, errors: s.errors, rankCostUsd: s.rankCostUsd }])),
        stockEnabled,
        aroll: aroll.map((a) => ({ assetId: a.assetId, key: a.key })),
        related: { assets: related.assets.map((a) => ({ assetId: a.assetId, key: a.key })), pages: related.pages, found: related.found, shortfall: related.shortfall, errors: related.errors },
        shots: { need, assign: assignment.method, unusedImages: assignment.unused, assignCostUsd: assignment.costUsd },
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
        await tx.update(schema.projects).set({ state: "composed", busyStep: null, busyProgress: null, lastError: null, approvedTimelineId: null, approvedBy: null, approvedAt: null }).where(eq(schema.projects.id, projectId));
        return t;
      });
      const costUsd = voices.reduce((a, v) => a + v.costUsd, 0) + Object.values(stock).reduce((a, s) => a + s.rankCostUsd, 0) + assignment.costUsd + mix.costUsd;
      await logActivity({
        actorId: requestedBy, organizationId, projectId, type: "timeline.built",
        payload: { timelineId: row.id, version: row.version, durationSec, scenes: doc.scenes.length, stockScenes: Object.values(stock).filter((s) => s.selected).length, imageScenes: doc.scenes.filter((s) => s.visual.kind === "image").length, shots: doc.scenes.reduce((a, s) => a + 1 + s.shots.length, 0), shotsShort: doc.scenes.reduce((a, s) => a + Math.max(0, need[s.id] - 1 - s.shots.length), 0), relatedImages: related.assets.length, music: music.pick?.source ?? null, timing: voices.map((v) => v.timing), costUsd: Math.round(costUsd * 1e4) / 1e4 },
      });
      return { ...row, durationSec };
    });

    const next = await step.run("auto-continue", () => autoAfterAssets(ctx, projectId, stored.id, stored.durationSec));
    if (next) await step.sendEvent("auto-render", next);

    return { timelineId: stored.id, version: stored.version, durationSec: stored.durationSec, auto: Boolean(next) };
  },
);
