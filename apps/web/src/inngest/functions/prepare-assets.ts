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
import { analyseAsset, faceGuardAvailable } from "@/lib/media/faces";
import { frameStill, overlayZones, type FrameFaces, type Framing } from "@/lib/media/framing";
import { aiImagesAvailable, generateSceneImages } from "@/lib/media/generate";
import { pickMusic } from "@/lib/media/music";
import { assignImages } from "@/lib/media/rank";
import { findRelatedImages, storeRelatedImages } from "@/lib/media/related";
import { mixDocAudio } from "@/lib/media/remix";
import { downloadToR2, stockProvidersAvailable } from "@/lib/media/stock";
import { sceneTimings, shotsNeeded } from "@/lib/media/timeline";
import { loadPronunciations, loadVoicePreset, synthesizeScene, type SceneVoice } from "@/lib/media/tts";
import { allocateChecked, orderByTier, SHOT_SEC, shortfall, splitBudget, total, videoSegments, VISUAL_TIERS, youtubeId, type PendingCapture, type VisualTier } from "@/lib/media/visual-plan";
import { findWebVideos, storeWebVideo, webVideoEnabled, webVideoHint, type WebVideoCandidate } from "@/lib/media/webvideo";
import { deleteObject, r2Key } from "@/lib/r2";

const ext = (url: string, fallback: string) => {
  const m = /\.(jpe?g|png|webp|mp4|mov)(?:$|\?)/i.exec(url);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallback;
};

/** Most AI stills one build may request, on top of the user's daily `ai_media` quota. */
const MAX_AI_PER_BUILD = 8;

/**
 * Pipeline steps 3–6 (docs/PLAN.md §4): visuals, TTS with word timings and
 * pronunciations, music, media-Lambda audio mix, then a new timeline version.
 * The project moves to `composed`; re-running creates the next version and
 * leaves old assets.
 *
 * Every scene is cut into shots so the picture changes at least every 5 s
 * (`shotsNeeded`), and no visual is used twice in the video. Pictures are
 * sourced in the priority of `visual-plan.ts`, each tier only for the shots
 * the earlier tiers left open: the article's own images → images from other
 * outlets covering the same story together with same-story footage from video
 * sites (yt-dlp, flag) → free stock clips (Pexels / Pixabay, Haiku-ranked) →
 * AI-generated stills (Gemini on Vertex, flag + quota).
 *
 * Stills from the article and other outlets pass the face guard (`framing.ts`,
 * flag `face_guard`) before they are placed: faces not cropped by the 9:16
 * frame, not under text overlays or platform UI, centred on the upper-third
 * line. A still that fails in its scene leaves the pool, so another candidate
 * or a later tier takes the shot; it only comes back when nothing else could.
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

    /* ---- shot budget: one picture per ≤ 5 s of voice, one for the CTA ---- */
    const voiceMs = (id: string, fallbackSec: number) => voices.find((v) => v.sceneId === id)?.durationMs ?? fallbackSec * 1000;
    const need: Record<string, number> = Object.fromEntries(input.scenes.map((sc) => [sc.id, sc.kind === "cta" ? 1 : shotsNeeded(voiceMs(sc.id, sc.durationSec))]));
    const totalNeed = total(need);

    /* ---- tier 1: the article's own images ---- */
    const aroll = await step.run("aroll", async (): Promise<ChosenAsset[]> => {
      await reportProgress(pctx, { label: `1/4 Ảnh từ bài báo (${input.images.length} ảnh, cần ${totalNeed} shot)`, pct: 30 });
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

    /* ---- tier 2 (one rank): other outlets' images of the same story ∥ same-story footage from video sites, only for the shots the article cannot fill ---- */
    const tier2Missing = totalNeed - aroll.length;
    const [related, webSearch] = await Promise.all([
      step.run("related-aroll", async () => {
        await reportProgress(pctx, { label: tier2Missing > 0 ? `2/4 Tìm thêm ${tier2Missing} hình từ báo khác + video web cùng tin` : "2/4 Bài báo đủ ảnh, không cần báo khác", pct: 36 });
        if (tier2Missing <= 0) return { assets: [] as ChosenAsset[], pages: 0, found: 0, errors: [] as string[], shortfall: tier2Missing };
        const found = await findRelatedImages({ query: input.articleTitle, language: input.language, excludeUrls: [input.source.url], want: tier2Missing });
        const stored = await storeRelatedImages(found.images, { buildId: input.buildId, max: tier2Missing + 2 }, pctx);
        return { assets: stored.assets, pages: found.pages, found: found.images.length, errors: [...found.errors, ...stored.errors], shortfall: tier2Missing };
      }),
      step.run("web-video-search", async () => {
        const off = (reason: string) => ({ enabled: false, reason, candidates: [] as WebVideoCandidate[], searched: 0, errors: [] as string[] });
        if (tier2Missing <= 0) return off("đủ ảnh");
        if (!(await webVideoEnabled())) return off("cờ web_video_downloader tắt");
        const r = await findWebVideos({ query: input.articleTitle, language: input.language, limit: 8 });
        return { enabled: true, reason: null as string | null, candidates: r.candidates.slice(0, 8), searched: r.searched, errors: r.errors };
      }),
    ]);

    /* ---- candidate pool in priority order; a web video counts for as many shots as its usable 5 s segments ---- */
    type PoolItem = { tier: VisualTier; asset: ChosenAsset | null; video: WebVideoCandidate | null; capacity: number; thumbnailUrl: string | null; hint: string };
    const pool: PoolItem[] = [
      ...aroll.map((a): PoolItem => ({ tier: "article", asset: a, video: null, capacity: 1, thumbnailUrl: a.thumbnailUrl, hint: "source article" })),
      ...related.assets.map((a): PoolItem => ({ tier: "related", asset: a, video: null, capacity: 1, thumbnailUrl: a.thumbnailUrl, hint: "other outlet" })),
      ...webSearch.candidates.map((c): PoolItem => {
        const seg = videoSegments(c.durationSec);
        return { tier: "web_video", asset: null, video: c, capacity: seg.capacity, thumbnailUrl: c.thumbnailUrl, hint: webVideoHint(c, seg.capacity) };
      }),
    ];
    const wanting = input.scenes.map((sc) => ({ id: sc.id, voiceover: sc.voiceover, onScreenText: sc.onScreenText, want: need[sc.id] }));

    /* ---- face guard, part 1: find the faces in every still of the pool (Cloud Vision, once per picture) ---- */
    const faceScan = await step.run("face-guard", async () => {
      const stills = pool.flatMap((it, index) => (it.asset?.kind === "image" ? [{ index, asset: it.asset }] : []));
      const a = await faceGuardAvailable();
      if (!a.enabled || stills.length === 0) return { enabled: a.enabled, reason: a.reason, frames: {} as Record<string, FrameFaces>, errors: [] as string[], costUsd: 0 };
      await reportProgress(pctx, { label: `Kiểm tra khuôn mặt trong ${stills.length} ảnh (không cắt, không bị chữ che, đúng đường 1/3 trên)`, pct: 40 });
      const frames: Record<string, FrameFaces> = {};
      const errors: string[] = [];
      let costUsd = 0;
      for (let i = 0; i < stills.length; i += 4) {
        const batch = await Promise.all(stills.slice(i, i + 4).map(async (s) => ({ index: s.index, r: await analyseAsset(s.asset, pctx) })));
        for (const { index, r } of batch) {
          if (r.frame) frames[index] = r.frame;
          if (r.error) errors.push(r.error);
          costUsd += r.costUsd;
        }
      }
      return { enabled: true, reason: null as string | null, frames, errors, costUsd };
    });
    /* ---- face guard, part 2 (pure): the crop of pool item `index` under the overlays of scene `sc` ---- */
    const framings = new Map<string, Framing>();
    const framingFor = (index: number, sceneId: string): Framing => {
      const k = `${index}:${sceneId}`;
      let f = framings.get(k);
      if (!f) {
        const sc = input.scenes.find((s) => s.id === sceneId);
        const zones = overlayZones({
          kind: sc?.kind ?? "body",
          headline: sc?.onScreenText ?? "",
          captionPosition: brand.brand.caption.position,
          captionFontSize: brand.brand.caption.fontSize,
          hasCaptions: Boolean(sc?.voiceover.trim()),
          showSource: brand.brand.showSource && Boolean(input.source.name),
          hasLogo: Boolean(brand.brand.logoSrc),
        });
        f = frameStill(faceScan.frames[index] ?? null, zones);
        framings.set(k, f);
      }
      return f;
    };
    const faceOk = (index: number, sceneId: string) => framingFor(index, sceneId).ok;

    /* ---- which candidate goes to which scene: Haiku matches subjects by thumbnail; every candidate at most once (videos once per segment) ---- */
    const assignment = await step.run("assign-images", async () => {
      await reportProgress(pctx, { label: `Xếp ${pool.length} hình/video vào cảnh (Haiku)`, pct: 44 });
      let picks: Record<string, number[]> = {};
      let costUsd = 0;
      let method: "haiku" | "sequential" = "sequential";
      if (pool.length) {
        try {
          const r = await assignImages(wanting, pool.map((it) => ({ key: it.asset?.key ?? it.video?.url ?? "", thumbnailUrl: it.thumbnailUrl ?? "", hint: it.hint })).filter((c) => c.thumbnailUrl), pctx);
          picks = Object.fromEntries(r.picks);
          costUsd = r.costUsd;
          method = "haiku";
        } catch (e) {
          console.warn("[assets] image assignment failed, assigning in order", e);
        }
      }
      return { picks, method, costUsd };
    });

    /* ---- download only the web videos the plan uses, and only the section their shots need ---- */
    const provisional = allocateChecked(wanting, pool.length, assignment.picks, pool.map((it) => it.capacity), faceOk);
    const videoUse = new Map<number, number>();
    for (const list of Object.values(provisional.perScene)) for (const p of list) if (pool[p.index].video) videoUse.set(p.index, Math.max(videoUse.get(p.index) ?? 0, p.segment + 1));
    const downloads = await Promise.all(
      [...videoUse.entries()].map(([index, segments]) =>
        step.run(`webvideo-${index}`, async (): Promise<{ index: number; asset: ChosenAsset | null; error: string | null }> => {
          const c = pool[index].video!;
          const seg = videoSegments(c.durationSec);
          await reportProgress(pctx, { label: `Tải ${segments * SHOT_SEC} s từ ${c.site}: ${c.title.slice(0, 40)}`, pct: 46 });
          try {
            const asset = await storeWebVideo(c, { buildId: input.buildId, startSec: seg.startSec, endSec: seg.startSec + segments * SHOT_SEC, index }, pctx);
            return { index, asset, error: null };
          } catch (e) {
            return { index, asset: null, error: `${c.site} ${c.url.slice(0, 80)}: ${(e as Error).message.slice(0, 200)}` };
          }
        }),
      ),
    );
    for (const d of downloads) {
      pool[d.index].asset = d.asset;
      if (!d.asset) pool[d.index].capacity = 0;
    }
    // Final placement: same picks, but a video whose download failed is out of the pool.
    const placed = allocateChecked(wanting, pool.length, assignment.picks, pool.map((it) => (it.video && !it.asset ? 0 : it.capacity)), faceOk);
    const placedCount: Record<string, number> = Object.fromEntries(input.scenes.map((sc) => [sc.id, placed.perScene[sc.id]?.length ?? 0]));
    const afterStills = shortfall(need, placedCount);
    const webVideoAssets = downloads.flatMap((d) => (d.asset ? [d.asset] : []));
    // YouTube picks the Lambda could not fetch (datacenter IPs are bot-checked): the editor can record them in the user's browser.
    const pendingCaptures: PendingCapture[] = downloads.flatMap((d) => {
      const c = pool[d.index].video;
      const videoId = c ? youtubeId(c.url) : null;
      if (d.asset || !c || !videoId) return [];
      const scenes = input.scenes.flatMap((sc) => {
        const n = (provisional.perScene[sc.id] ?? []).filter((p) => p.index === d.index).length;
        return n ? [{ sceneId: sc.id, segments: n }] : [];
      });
      return [{ videoId, url: c.url, title: c.title, uploader: c.uploader, thumbnailUrl: c.thumbnailUrl, startSec: videoSegments(c.durationSec).startSec, segments: videoUse.get(d.index) ?? 1, scenes, error: d.error ?? "" }];
    });

    /* ---- tier 3: stock B-roll per scene (parallel), only as many clips as the scene still lacks ---- */
    const stockScenes = input.scenes.filter((sc) => sc.kind !== "cta" && sc.brollTerms.length && afterStills[sc.id] > 0);
    const providers = await step.run("stock-providers", async () => {
      const p = await stockProvidersAvailable();
      const on = !skipStock && (p.pexels || p.pixabay);
      const missing = total(afterStills);
      await reportProgress(pctx, {
        label: missing === 0 ? "3/4 Đủ ảnh, không cần stock" : on ? `3/4 Tìm ${missing} clip Pexels/Pixabay, Haiku xếp hạng (${stockScenes.length} cảnh)` : skipStock ? "3/4 Bỏ qua stock theo yêu cầu" : "3/4 Chưa có key Pexels/Pixabay",
        pct: 48,
        total: stockScenes.length,
      });
      return p;
    });
    const stockEnabled = !skipStock && (providers.pexels || providers.pixabay);
    const stock: Record<string, SceneStock> = {};
    if (stockEnabled && stockScenes.length) {
      const results = await Promise.all(
        stockScenes.map((sc) =>
          step.run(`stock-${sc.id}`, async (): Promise<[string, SceneStock]> => {
            const wantSec = Math.min(5, voiceMs(sc.id, sc.durationSec) / 1000);
            const r = await fetchSceneBroll(sc, { wantSec, buildId: input.buildId, keep: afterStills[sc.id] }, pctx);
            await tickProgress(pctx, { label: "B-roll cảnh", total: stockScenes.length, from: 48, to: 62 });
            return [sc.id, r];
          }),
        ),
      );
      for (const [id, r] of results) stock[id] = r;
    }
    const stockCount: Record<string, number> = Object.fromEntries(input.scenes.map((sc) => [sc.id, stock[sc.id] ? (stock[sc.id].selected ? 1 : 0) + stock[sc.id].alternates.length : 0]));
    const afterStock = shortfall(need, Object.fromEntries(input.scenes.map((sc) => [sc.id, placedCount[sc.id] + stockCount[sc.id]])));

    /* ---- tier 4: AI stills (Gemini on Vertex) for whatever is still missing, within flag, spend cap and daily quota ---- */
    const aiScenes = input.scenes.filter((sc) => sc.kind !== "cta" && afterStock[sc.id] > 0);
    const aiPlan = await step.run("ai-plan", async () => {
      const missing = total(afterStock);
      if (missing === 0) {
        await reportProgress(pctx, { label: "4/4 Đủ hình, không cần AI", pct: 64 });
        return { enabled: false, reason: null as string | null, counts: {} as Record<string, number>, projectId: null as string | null };
      }
      const a = await aiImagesAvailable(requestedBy);
      if (!a.enabled) {
        await reportProgress(pctx, { label: `4/4 Thiếu ${missing} hình, không tạo AI (${a.reason})`, pct: 64 });
        return { enabled: false, reason: a.reason, counts: {}, projectId: null };
      }
      const counts = splitBudget(aiScenes.map((sc) => ({ id: sc.id, want: afterStock[sc.id] })), Math.min(a.remaining, MAX_AI_PER_BUILD));
      await reportProgress(pctx, { label: `4/4 Tạo ${total(counts)}/${missing} ảnh AI (Gemini)`, pct: 64, total: aiScenes.length });
      return { enabled: true, reason: null, counts, projectId: a.projectId };
    });
    const ai: Record<string, { assets: ChosenAsset[]; errors: string[]; costUsd: number }> = {};
    if (aiPlan.enabled && aiPlan.projectId) {
      const results = await Promise.all(
        aiScenes
          .filter((sc) => (aiPlan.counts[sc.id] ?? 0) > 0)
          .map((sc) =>
            step.run(`ai-${sc.id}`, async (): Promise<[string, { assets: ChosenAsset[]; errors: string[]; costUsd: number }]> => {
              const r = await generateSceneImages(sc, { count: aiPlan.counts[sc.id], buildId: input.buildId, language: input.language, projectId: aiPlan.projectId! }, pctx);
              await tickProgress(pctx, { label: "Ảnh AI", total: aiScenes.length, from: 64, to: 74 });
              return [sc.id, r];
            }),
          ),
      );
      for (const [id, r] of results) ai[id] = r;
    }

    /* ---- stills the face guard turned down come back, last in their scene, only where no tier could fill the shot ---- */
    const forced: Record<string, number[]> = {};
    {
      const spare = placed.rejected.map((r) => r.index);
      for (const sc of input.scenes) {
        const have = placedCount[sc.id] + Math.min(stockCount[sc.id], afterStills[sc.id]) + (ai[sc.id]?.assets.length ?? 0);
        forced[sc.id] = spare.splice(0, Math.max(0, need[sc.id] - have));
      }
    }

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
      const still = (im: ChosenAsset, f?: Framing): EditorScene["visual"] => ({ kind: "image", key: im.key, kenBurns: f?.kenBurns ?? true, focus: f?.focus ?? null, credit: im.credit, assetId: im.assetId, thumbnailUrl: im.thumbnailUrl });
      const scenes: EditorScene[] = input.scenes.map((sc) => {
        const v = voices.find((x) => x.sceneId === sc.id) ?? null;
        const s = stock[sc.id];
        const segment = (a: ChosenAsset, n: number): EditorScene["visual"] => ({ kind: "video", key: a.key, clipDurationSec: SHOT_SEC, trimStartSec: n * SHOT_SEC, credit: a.credit, assetId: a.assetId, thumbnailUrl: a.thumbnailUrl });
        const shots: Array<{ tier: VisualTier; visual: EditorScene["visual"] }> = [
          ...(placed.perScene[sc.id] ?? []).flatMap((p) => {
            const it = pool[p.index];
            return it.asset ? [{ tier: it.tier, visual: it.video ? segment(it.asset, p.segment) : still(it.asset, framingFor(p.index, sc.id)) }] : [];
          }),
          ...(s ? [...(s.selected ? [s.selected] : []), ...s.alternates].slice(0, afterStills[sc.id]).map((c) => ({ tier: "stock" as VisualTier, visual: clip(c) })) : []),
          ...(ai[sc.id]?.assets ?? []).map((a) => ({ tier: "ai" as VisualTier, visual: still(a) })),
        ];
        // The most authentic picture opens the scene; every tier keeps its own order.
        const lastResort = (forced[sc.id] ?? []).flatMap((index) => (pool[index].asset ? [still(pool[index].asset!, framingFor(index, sc.id))] : []));
        const all = [...orderByTier(shots).map((x) => x.visual), ...lastResort].slice(0, need[sc.id]);
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
      const aiAssets = Object.values(ai).flatMap((r) => r.assets);
      const aiCostUsd = Object.values(ai).reduce((a, r) => a + r.costUsd, 0);
      const buildJson = {
        buildId: input.buildId,
        scriptVersion: input.scriptVersion,
        voice: { preset: voiceSetup.preset.voice, scenes: voices.map((v) => ({ sceneId: v.sceneId, key: v.key, durationMs: v.durationMs, timing: v.timing, matched: v.matched, words: v.words.length, chars: v.chars, spokenText: v.spokenText, pronunciations: v.pronunciationsApplied, costUsd: v.costUsd })) },
        /** Sourcing order and what each tier contributed per scene. */
        visuals: {
          order: VISUAL_TIERS,
          need,
          perScene: Object.fromEntries(
            input.scenes.map((sc) => {
              const tiers = (placed.perScene[sc.id] ?? []).map((p) => pool[p.index].tier);
              const n = (t: VisualTier) => tiers.filter((x) => x === t).length;
              return [sc.id, { article: n("article"), related: n("related"), web_video: n("web_video"), stock: Math.min(stockCount[sc.id], afterStills[sc.id]), ai: ai[sc.id]?.assets.length ?? 0 }];
            }),
          ),
        },
        stock: Object.fromEntries(Object.entries(stock).map(([id, s]) => [id, { selected: s.selected, alternates: s.alternates, searched: s.searched, errors: s.errors, rankCostUsd: s.rankCostUsd }])),
        stockEnabled,
        aroll: aroll.map((a) => ({ assetId: a.assetId, key: a.key })),
        related: { assets: related.assets.map((a) => ({ assetId: a.assetId, key: a.key })), pages: related.pages, found: related.found, shortfall: related.shortfall, errors: related.errors },
        webVideo: { enabled: webSearch.enabled, reason: webSearch.reason, searched: webSearch.searched, candidates: webSearch.candidates.map((c) => ({ url: c.url, title: c.title, site: c.site, durationSec: c.durationSec })), assets: webVideoAssets.map((a) => ({ assetId: a.assetId, key: a.key, durationSec: a.durationSec })), pending: pendingCaptures, errors: [...webSearch.errors, ...downloads.flatMap((d) => (d.error ? [d.error] : []))] },
        ai: { enabled: aiPlan.enabled, reason: aiPlan.reason, assets: aiAssets.map((a) => ({ assetId: a.assetId, key: a.key })), errors: Object.values(ai).flatMap((r) => r.errors), costUsd: aiCostUsd },
        /** Face guard: what was scanned, which stills were turned down for which scene and why, and which had to be used anyway. */
        framing: {
          enabled: faceScan.enabled,
          reason: faceScan.reason,
          checked: Object.keys(faceScan.frames).length,
          withFaces: Object.values(faceScan.frames).filter((f) => f.faces.length > 0).length,
          reframed: doc.scenes.reduce((a, s) => a + [s.visual, ...s.shots].filter((v) => v.kind === "image" && v.focus).length, 0),
          rejected: placed.rejected.map((r) => ({ assetId: pool[r.index].asset?.assetId ?? null, key: pool[r.index].asset?.key ?? null, sceneId: r.sceneId, issues: framingFor(r.index, r.sceneId).issues })),
          forced: Object.entries(forced).flatMap(([sceneId, list]) => list.map((index) => ({ assetId: pool[index].asset?.assetId ?? null, sceneId, issues: framingFor(index, sceneId).issues }))),
          errors: faceScan.errors,
          costUsd: faceScan.costUsd,
        },
        shots: { need, assign: assignment.method, unusedCandidates: pool.length - placed.used, assignCostUsd: assignment.costUsd },
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
        // A rebuild supersedes any approval of the previous version. AI-generated visuals turn the publish-time disclosure on.
        await tx
          .update(schema.projects)
          .set({ state: "composed", busyStep: null, busyProgress: null, lastError: null, approvedTimelineId: null, approvedBy: null, approvedAt: null, ...(aiAssets.length ? { aiDisclosure: true } : {}) })
          .where(eq(schema.projects.id, projectId));
        return t;
      });
      const costUsd = voices.reduce((a, v) => a + v.costUsd, 0) + Object.values(stock).reduce((a, s) => a + s.rankCostUsd, 0) + assignment.costUsd + faceScan.costUsd + aiCostUsd + mix.costUsd;
      await logActivity({
        actorId: requestedBy, organizationId, projectId, type: "timeline.built",
        payload: { timelineId: row.id, version: row.version, durationSec, scenes: doc.scenes.length, stockScenes: Object.values(stock).filter((s) => s.selected).length, imageScenes: doc.scenes.filter((s) => s.visual.kind === "image").length, shots: doc.scenes.reduce((a, s) => a + 1 + s.shots.length, 0), shotsShort: doc.scenes.reduce((a, s) => a + Math.max(0, need[s.id] - 1 - s.shots.length), 0), relatedImages: related.assets.length, webVideos: webVideoAssets.length, faceRejected: placed.rejected.length, faceForced: total(Object.fromEntries(Object.entries(forced).map(([k, v]) => [k, v.length]))), aiImages: aiAssets.length, aiSkipped: aiPlan.reason, music: music.pick?.source ?? null, timing: voices.map((v) => v.timing), costUsd: Math.round(costUsd * 1e4) / 1e4 },
      });
      return { ...row, durationSec };
    });

    const next = await step.run("auto-continue", () => autoAfterAssets(ctx, projectId, stored.id, stored.durationSec));
    if (next) await step.sendEvent("auto-render", next);

    return { timelineId: stored.id, version: stored.version, durationSec: stored.durationSec, auto: Boolean(next) };
  },
);
