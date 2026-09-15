import { NonRetriableError } from "inngest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inngest } from "../client";
import { projectAssetsRequested } from "../events";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import type { StoredScript } from "@/lib/llm/schemas";
import { loadBrand } from "@/lib/media/brand";
import { pickMusic } from "@/lib/media/music";
import { rankCandidates } from "@/lib/media/rank";
import { downloadToR2, searchStock, stockProvidersAvailable, type StockCandidate } from "@/lib/media/stock";
import { buildTimeline, sceneTimings, type SceneVisualInput } from "@/lib/media/timeline";
import { loadPronunciations, loadVoicePreset, synthesizeScene, type SceneVoice } from "@/lib/media/tts";
import { invokeMediaLambda } from "@/lib/media-lambda";
import { deleteObject, r2Key } from "@/lib/r2";

type ChosenAsset = { assetId: string; key: string; kind: "video" | "image"; durationSec: number | null; credit: string | null; provider: string; thumbnailUrl: string | null };
type SceneStock = { selected: ChosenAsset | null; alternates: ChosenAsset[]; searched: number; errors: string[]; rankCostUsd: number };

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
              const { candidates, errors } = await searchStock(sc.brollTerms.slice(0, 3), { perTerm: 4, wantSec });
              if (candidates.length === 0) return [sc.id, { selected: null, alternates: [], searched: 0, errors, rankCostUsd: 0 }];
              let ranked: Array<StockCandidate & { score: number; reason: string }>;
              let rankCostUsd = 0;
              try {
                const r = await rankCandidates({ voiceover: sc.voiceover, onScreenText: sc.onScreenText, brollTerms: sc.brollTerms }, candidates.slice(0, 8), pctx);
                ranked = r.ranked;
                rankCostUsd = r.costUsd;
              } catch (e) {
                errors.push(`rank: ${(e as Error).message}`);
                ranked = candidates.slice(0, 8).map((c) => ({ ...c, score: 0, reason: "unranked" }));
              }
              const chosen: ChosenAsset[] = [];
              for (const c of ranked) {
                if (chosen.length >= 2) break;
                if (c.score < 15 && chosen.length > 0) break;
                try {
                  // Dedupe org-wide by provider id first (no download), then by content hash.
                  const existing = await withOrgContext(ctx, (tx) =>
                    tx.query.assets.findFirst({ where: and(eq(schema.assets.organizationId, organizationId), eq(schema.assets.provider, c.provider), eq(schema.assets.providerId, c.providerId)) }),
                  );
                  let key = existing?.r2Path ?? media(`broll/${input.buildId}-${sc.id}-${c.provider}-${c.providerId}.${ext(c.downloadUrl, "mp4")}`);
                  let hash = existing?.hash ?? null;
                  let sizeBytes = existing?.sizeBytes ?? null;
                  let mime = existing?.mime ?? "video/mp4";
                  if (!existing) {
                    const dl = await downloadToR2(c.downloadUrl, key);
                    hash = dl.hash;
                    sizeBytes = dl.sizeBytes;
                    mime = dl.contentType;
                    const dup = await withOrgContext(ctx, (tx) => tx.query.assets.findFirst({ where: and(eq(schema.assets.organizationId, organizationId), eq(schema.assets.hash, dl.hash)) }));
                    if (dup) {
                      await deleteObject(key).catch(() => {});
                      key = dup.r2Path;
                    }
                  }
                  const credit = `Video: ${c.author ? `${c.author} / ` : ""}${c.provider === "pexels" ? "Pexels" : "Pixabay"}`;
                  const [row] = await withOrgContext(ctx, (tx) =>
                    tx
                      .insert(schema.assets)
                      .values({
                        organizationId, projectId, origin: "stock", provider: c.provider, providerId: c.providerId, licence: c.licence, licenceUrl: c.licenceUrl, sourceUrl: c.pageUrl, r2Path: key, hash, mime,
                        width: c.width, height: c.height, durationSec: c.durationSec.toFixed(2), sizeBytes, searchTerm: c.searchTerm, rankScore: c.score.toFixed(2), rankReason: c.reason, sceneId: sc.id, selected: chosen.length === 0, thumbnailUrl: c.thumbnailUrl, attribution: credit,
                        meta: { buildId: input.buildId, author: c.author },
                      })
                      .returning({ id: schema.assets.id }),
                  );
                  chosen.push({ assetId: row.id, key, kind: "video", durationSec: c.durationSec, credit, provider: c.provider, thumbnailUrl: c.thumbnailUrl });
                } catch (e) {
                  errors.push(`${c.provider}:${c.providerId}: ${(e as Error).message.slice(0, 200)}`);
                }
              }
              return [sc.id, { selected: chosen[0] ?? null, alternates: chosen.slice(1), searched: candidates.length, errors, rankCostUsd }];
            }),
          ),
      );
      for (const [id, r] of results) stock[id] = r;
    }

    /* ---- music ---- */
    const preTiming = sceneTimings({ scenes: input.scenes.map((sc) => ({ ...sc, voice: voices.find((v) => v.sceneId === sc.id) ?? null, visual: null })) });
    const music = await step.run("music", () => pickMusic({ tone: input.tone, durationSec: preTiming.durationSec, r2Key: media(`music/${input.buildId}.mp3`) }, pctx));

    /* ---- audio mix (media Lambda) ---- */
    const mixKeys = { mixKey: media(`mix/${input.buildId}.wav`), voiceKey: media(`mix/${input.buildId}-vo.wav`) };
    const mix = await step.run("mix", async () => {
      const res = await invokeMediaLambda({
        action: "mix",
        input: {
          voice: voices.map((v) => ({ key: v.key, atSec: preTiming.timings.find((t) => t.id === v.sceneId)!.atSec })),
          music: music.pick ? { key: music.pick.key, gainDb: -12, fadeOutSec: 1.5 } : null,
        },
        output: { key: mixKeys.mixKey, voiceKey: mixKeys.voiceKey },
        durationSec: preTiming.durationSec,
        voiceLufs: -16,
        duckDb: -12,
      });
      if (!res.ok) throw new Error(`audio mix failed: ${res.error ?? "unknown"}`);
      return { integratedLufs: res.integratedLufs ?? null, billedMs: res.billedMs ?? null };
    });

    /* ---- timeline version ---- */
    const stored = await step.run("store-timeline", async () => {
      let imageIdx = 0;
      const nextImage = (): SceneVisualInput => {
        if (!aroll.length) return null;
        const im = aroll[imageIdx % aroll.length];
        imageIdx += 1;
        return { kind: "image", key: im.key, credit: im.credit };
      };
      const scenes = input.scenes.map((sc) => {
        const v = voices.find((x) => x.sceneId === sc.id) ?? null;
        const st = stock[sc.id]?.selected ?? null;
        const visual: SceneVisualInput = st ? { kind: "video", key: st.key, clipDurationSec: st.durationSec ?? 5, credit: st.credit } : nextImage();
        return { id: sc.id, kind: sc.kind, onScreenText: sc.onScreenText, durationSec: sc.durationSec, voice: v ? { key: v.key, durationMs: v.durationMs, words: v.words } : null, visual };
      });
      const { timeline, durationSec } = buildTimeline({
        title: input.title,
        language: input.language,
        source: input.source,
        brand: brand.brand,
        scenes,
        music: music.pick ? { key: music.pick.key, gainDb: -12, attribution: music.pick.attribution } : null,
        audio: mixKeys,
      });
      const buildJson = {
        buildId: input.buildId,
        scriptVersion: input.scriptVersion,
        voice: { preset: voiceSetup.preset.voice, scenes: voices.map((v) => ({ sceneId: v.sceneId, durationMs: v.durationMs, timing: v.timing, matched: v.matched, words: v.words.length, chars: v.chars, pronunciations: v.pronunciationsApplied, costUsd: v.costUsd })) },
        stock: Object.fromEntries(Object.entries(stock).map(([id, s]) => [id, { selected: s.selected, alternates: s.alternates, searched: s.searched, errors: s.errors, rankCostUsd: s.rankCostUsd }])),
        stockEnabled,
        aroll: aroll.map((a) => ({ assetId: a.assetId, key: a.key })),
        music: music.pick ? { source: music.pick.source, title: music.pick.title, licence: music.pick.licence, key: music.pick.key } : null,
        musicError: music.error,
        mix: { ...mix, ...mixKeys },
        brandKitId: brand.id,
      };
      const row = await withOrgContext(ctx, async (tx) => {
        const latest = await tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, projectId), orderBy: desc(schema.timelines.version) });
        const [t] = await tx
          .insert(schema.timelines)
          .values({ organizationId, projectId, version: (latest?.version ?? 0) + 1, json: timeline as unknown as Record<string, unknown>, scriptId: input.scriptId, durationSec: durationSec.toFixed(2), buildJson, createdBy: requestedBy })
          .returning({ id: schema.timelines.id, version: schema.timelines.version });
        const selectedIds = Object.values(stock).flatMap((s) => (s.selected ? [s.selected.assetId] : []));
        if (selectedIds.length) await tx.update(schema.assets).set({ selected: true }).where(inArray(schema.assets.id, selectedIds));
        await tx.update(schema.projects).set({ state: "composed", busyStep: null, lastError: null }).where(eq(schema.projects.id, projectId));
        return t;
      });
      const costUsd = voices.reduce((a, v) => a + v.costUsd, 0) + Object.values(stock).reduce((a, s) => a + s.rankCostUsd, 0);
      await logActivity({
        actorId: requestedBy, organizationId, projectId, type: "timeline.built",
        payload: { timelineId: row.id, version: row.version, durationSec, scenes: scenes.length, stockScenes: Object.values(stock).filter((s) => s.selected).length, imageScenes: scenes.filter((s) => s.visual?.kind === "image").length, music: music.pick?.source ?? null, timing: voices.map((v) => v.timing), costUsd: Math.round(costUsd * 1e4) / 1e4 },
      });
      return { ...row, durationSec };
    });

    return { timelineId: stored.id, version: stored.version, durationSec: stored.durationSec };
  },
);
