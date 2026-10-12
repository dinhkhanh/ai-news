"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { inngest } from "@/inngest/client";
import { projectComicBuildRequested } from "@/inngest/events";
import { run, str, type ActionState } from "@/lib/admin";
import { comicToScript, episodeRanges, pageRange } from "@/lib/comic/motion";
import { loadComic } from "@/lib/comic/service";
import { countWords } from "@/lib/fetch/readability";
import { flagEnabled } from "@/lib/flags";
import { MAX_SCENES } from "@/lib/media/editor";
import { channelLogo } from "@/lib/media/logo";
import { findVoice } from "@/lib/media/tts";
import { startProgress } from "@/lib/project-state";
import { assertWorkspaceWriter } from "@/lib/workspace";

/** Most episodes one click may make ("Chia thành tập"). */
const MAX_EPISODES = 10;

/**
 * "Làm video" (docs/COMIC.md §11.1, M4): the comic's current version, frozen, becomes one 9:16 video project per
 * episode (`source_kind = 'comic'`): a confirmed article holding the lines, script v1 built by `comicToScript`
 * (no model call, cost 0) and the build queued at once (`prepare-comic`). From there it is an ordinary project:
 * editor, review, render, publish. Making the video again after editing the comic makes a new project.
 */
export async function makeComicVideo(_: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    if (!(await flagEnabled("comics"))) throw new Error("Truyện tranh đang tắt (cờ comics trong /admin/integrations)");
    const comicId = str(fd, "comicId");
    const loaded = await loadComic(ws, comicId);
    if (!loaded) throw new Error("Không tìm thấy truyện này");
    if (!loaded.version) throw new Error("Truyện chưa có trang nào");
    const doc = loaded.version.doc;
    const range = pageRange(doc, { from: Number(str(fd, "from")) || 1, to: Number(str(fd, "to")) || doc.pages.length });
    const perEpisode = fd.get("split") === "on" ? Math.round(Number(str(fd, "perEpisode"))) : 0;
    if (fd.get("split") === "on" && !(perEpisode >= 1)) throw new Error("Số trang mỗi tập từ 1 trở lên");
    const ranges = perEpisode ? episodeRanges(range, perEpisode) : [range];
    if (ranges.length > MAX_EPISODES) throw new Error(`Tối đa ${MAX_EPISODES} tập một lần: tăng số trang mỗi tập`);
    const music = fd.get("music") === "on";

    const kitId = str(fd, "brandKitId");
    const kit = kitId ? await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.id, kitId)), columns: { id: true, name: true } })) : null;
    if (kitId && !kit) throw new Error("Bộ nhận diện này không còn nữa");
    const logoChannelId = str(fd, "logoChannelId");
    const logoChannel = await channelLogo(ws, logoChannelId);
    if (logoChannelId && !logoChannel) throw new Error("Kênh này không (còn) có logo");
    // The narrator: captions and every character without a voice of their own; "" = the workspace default.
    const voice = await findVoice(ws, str(fd, "voicePresetId"));

    const ids = { comicId, versionId: loaded.version.id };
    const built = ranges.map((r, i) => ({ range: r, out: comicToScript(doc, ids, { pages: r, episode: ranges.length > 1 ? { n: i + 1, of: ranges.length } : null, music }) }));
    const usable = built.filter((b): b is typeof b & { out: NonNullable<typeof b.out> } => Boolean(b.out));
    if (!usable.length) throw new Error("Các trang đã chọn chưa có khung nào được vẽ");
    const skipped = usable.reduce((a, b) => a + b.out.skipped, 0);
    const tooLong = usable.find((b) => b.out.script.scenes.length > MAX_SCENES);
    if (tooLong) throw new Error(`Trang ${tooLong.range.from}–${tooLong.range.to} có ${tooLong.out.script.scenes.length} lời thoại, một video tối đa ${MAX_SCENES}: chia thành tập`);

    const created = await withOrgContext(ws, async (tx) => {
      const out: { projectId: string; scriptId: string; title: string; pages: { from: number; to: number }; scenes: number; durationSec: number }[] = [];
      for (const { range: r, out: { script } } of usable) {
        const [project] = await tx
          .insert(schema.projects)
          .values({
            organizationId: ws.organizationId, ownerId: ws.userId, url: null, canonicalUrl: null, sourceKind: "comic", comicId, comicVersionId: ids.versionId, title: script.title, language: doc.language,
            durationSec: Math.min(600, Math.max(15, script.estimatedDurationSec)), tone: "casual", state: "scripted", aiDisclosure: true,
            brandKitId: kit?.id ?? null, brandKitSource: kit ? "manual" : null, logoChannelId: logoChannel?.id ?? null, voicePresetId: voice?.id ?? null,
            busyStep: "assets", busyProgress: startProgress("Dựng truyện động…"),
          })
          .returning({ id: schema.projects.id });
        // The lines as the project's content, so the project reads like any other (Nội dung, review).
        const text = script.scenes.map((s) => s.voiceover).filter(Boolean).join("\n");
        await tx.insert(schema.articles).values({ organizationId: ws.organizationId, projectId: project.id, title: script.title, text, excerpt: doc.logline || null, language: doc.language, fetchMethod: "comic", wordCount: countWords(text), confirmedAt: new Date(), confirmedBy: ws.userId });
        const [row] = await tx
          .insert(schema.scripts)
          .values({ organizationId: ws.organizationId, projectId: project.id, version: 1, scenesJson: script as unknown as Record<string, unknown>, model: "comic", costUsd: "0", createdBy: ws.userId })
          .returning({ id: schema.scripts.id });
        out.push({ projectId: project.id, scriptId: row.id, title: script.title, pages: r, scenes: script.scenes.length, durationSec: script.estimatedDurationSec });
      }
      return out;
    });

    for (const c of created) {
      await log("project.created", { sourceKind: "comic", comicId, comicVersionId: ids.versionId, pages: c.pages, scenes: c.scenes, estimatedSec: c.durationSec, music, brandKit: kit?.name ?? "default", logoChannel: logoChannel?.name ?? null, voice: voice?.name ?? "default" }, c.projectId);
      await inngest.send(projectComicBuildRequested.create({ projectId: c.projectId, organizationId: ws.organizationId, requestedBy: ws.userId, scriptId: c.scriptId }));
    }
    await log("comic.video_created", { comicId, versionId: ids.versionId, projectIds: created.map((c) => c.projectId), pages: range, episodes: created.length, skippedPanels: skipped, music });
    revalidatePath(`/app/comics/${comicId}`);
    const note = skipped ? ` (${skipped} khung chưa vẽ được bỏ qua)` : "";
    if (created.length === 1) {
      target = `/app/projects/${created[0].projectId}`;
      return `Đang dựng video${note}…`;
    }
    return `Đã tạo ${created.length} tập, đang dựng${note}. Mở từng tập ở danh sách bên dưới.`;
  });
  if (target) redirect(target);
  return state;
}
