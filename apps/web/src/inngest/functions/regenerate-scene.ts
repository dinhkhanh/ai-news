import { NonRetriableError } from "inngest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inngest } from "../client";
import { projectSceneRegenerateRequested } from "../events";
import { reportProgress } from "@/lib/progress";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { logActivity } from "@/lib/activity";
import { fetchSceneBroll } from "@/lib/media/broll";
import { voicePlacement, type EditorDoc, type EditorScene } from "@/lib/media/editor";
import { pickMusic } from "@/lib/media/music";
import { loadPronunciations, loadVoicePreset, synthesizeScene } from "@/lib/media/tts";
import { shotsNeeded } from "@/lib/media/timeline";
import { r2Key } from "@/lib/r2";
import { docOfRow, saveTimelineVersion } from "@/lib/review";

/**
 * Phase 4 (docs/PLAN.md §4.7 "regenerate one scene's B-roll or VO, change
 * music"): redo one part of the editor document and store the result as a
 * new timeline version (kind = regenerated) on top of the version the editor
 * was looking at. The optimistic lock in saveTimelineVersion rejects the
 * result if someone saved another version meanwhile.
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
    const { projectId, organizationId, requestedBy, timelineId, what, sceneId, voiceover, brollTerms } = event.data;
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
        return { tone: project.tone, timeline };
      });
      const { doc } = docOfRow(row.timeline);
      const stock = ((row.timeline.buildJson as { stock?: Record<string, unknown> }).stock ?? {}) as Record<string, unknown>;
      return { tone: row.tone, version: row.timeline.version, doc, stock };
    });

    const sceneIdx = base.doc.scenes.findIndex((s) => s.id === sceneId);
    if (what !== "music" && sceneIdx < 0) throw new NonRetriableError(`Scene ${sceneId} is not in timeline v${base.version}`);
    const scene = base.doc.scenes[sceneIdx] as EditorScene | undefined;

    let next: EditorDoc = base.doc;
    const changes: string[] = [];
    const build: Record<string, unknown> = {};

    if (what === "voice" && scene) {
      const text = (voiceover ?? scene.voiceover).trim();
      if (text.length < 2) throw new NonRetriableError("Voice-over text is empty");
      const v = await step.run("voice", async () => {
        await reportProgress(pctx, { label: `Đọc lại lời cảnh ${scene.id} (Google TTS)`, pct: 20 });
        const preset = await loadVoicePreset(ctx, base.doc.language);
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

    if (what === "broll" && scene) {
      const terms = (brollTerms?.length ? brollTerms : scene.brollTerms).map((t) => t.trim()).filter(Boolean);
      if (!terms.length) throw new NonRetriableError("Add at least one English search term for the B-roll");
      const sceneMs = (scene.voice?.durationMs ?? scene.durationSec * 1000) + scene.holdMs;
      const wantSec = Math.min(5, sceneMs / 1000);
      const keep = shotsNeeded(sceneMs);
      const res = await step.run("broll", async () => {
        await reportProgress(pctx, { label: `Tìm B-roll mới cho cảnh ${scene.id}`, pct: 20 });
        // Skip clips this project already fetched for the scene so a retry brings something new.
        const seen = await withOrgContext(ctx, (tx) => tx.query.assets.findMany({ where: and(eq(schema.assets.projectId, projectId), eq(schema.assets.sceneId, scene.id)), columns: { provider: true, providerId: true } }));
        const exclude = new Set(seen.map((a) => `${a.provider}:${a.providerId}`));
        return fetchSceneBroll({ id: scene.id, voiceover: scene.voiceover, onScreenText: scene.onScreenText, brollTerms: terms }, { wantSec, buildId, keep: Math.max(2, keep), exclude }, pctx);
      });
      if (!res.selected) throw new NonRetriableError(`Không tìm được clip mới cho ${scene.id}${res.errors[0] ? `: ${res.errors[0]}` : " (chưa có key Pexels/Pixabay?)"}`);
      const clips = [res.selected, ...res.alternates].slice(0, keep).map((c) => ({ kind: "video" as const, key: c.key, clipDurationSec: c.durationSec ?? 5, trimStartSec: 0, credit: c.credit, assetId: c.assetId, thumbnailUrl: c.thumbnailUrl }));
      // New clips take the first shots; keep the scene's remaining stills so the ≤ 5 s cadence holds.
      const keepStills = [scene.visual, ...scene.shots].filter((v) => v.kind === "image").slice(0, Math.max(0, keep - clips.length));
      const all = [...clips, ...keepStills];
      next = {
        ...base.doc,
        scenes: base.doc.scenes.map((s, i) => (i === sceneIdx ? { ...s, brollTerms: terms, visual: all[0], shots: all.slice(1) } : s)),
      };
      changes.push(`${scene.id}: B-roll mới (${clips.length} clip, ${res.searched} ứng viên, ${terms.join(", ")})`);
      build.stock = { ...base.stock, [scene.id]: { selected: res.selected, alternates: res.alternates, searched: res.searched, errors: res.errors, rankCostUsd: res.rankCostUsd } };
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
    return { timelineId: saved.id, version: saved.version, changes: saved.changes };
  },
);
