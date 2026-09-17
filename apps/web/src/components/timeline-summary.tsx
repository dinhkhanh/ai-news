import type { Timeline } from "@ai-news/video/schema";
import { Badge } from "@/components/ui/badge";

type SceneBuild = { sceneId: string; durationMs: number; timing: string; matched: number; words: number; chars: number; pronunciations: string[] };
type StockBuild = { selected: { provider: string; credit: string | null; thumbnailUrl: string | null; durationSec: number | null } | null; alternates: unknown[]; searched: number; errors: string[] };
type TierCounts = { article: number; related: number; web_video?: number; stock: number; ai: number };
export type BuildJson = {
  voice?: { preset: string; scenes: SceneBuild[] };
  stock?: Record<string, StockBuild>;
  stockEnabled?: boolean;
  /** Visual priority (article → related = web video → stock → AI) and what each tier gave per scene. */
  visuals?: { order: string[]; need: Record<string, number>; perScene: Record<string, TierCounts> };
  ai?: { enabled: boolean; reason: string | null; assets: unknown[]; errors: string[] };
  framing?: { enabled: boolean; reason: string | null; checked: number; withFaces: number; reframed: number; rejected: unknown[]; forced: unknown[]; errors: string[] };
  webVideo?: { enabled: boolean; reason: string | null; searched: number; assets: unknown[]; errors: string[] };
  music?: { source: string; title: string; licence: string } | null;
  musicError?: string | null;
  mix?: { integratedLufs: number | null };
};

const TIMING_LABEL: Record<string, string> = { ssml: "mốc SSML", stt: "STT", proportional: "ước lượng" };
const TIER_LABEL: Record<keyof TierCounts, string> = { article: "bài gốc", related: "báo khác", web_video: "video web", stock: "stock", ai: "AI" };
const TIER_ORDER: Array<keyof TierCounts> = ["article", "related", "web_video", "stock", "ai"];

const sceneTiers = (t: TierCounts) => TIER_ORDER.filter((k) => (t[k] ?? 0) > 0).map((k) => `${t[k]} ${TIER_LABEL[k]}`).join(" + ") || "thiếu hình";
const tierSummary = (per: Record<string, TierCounts>) => {
  const sum: Required<TierCounts> = { article: 0, related: 0, web_video: 0, stock: 0, ai: 0 };
  for (const t of Object.values(per)) for (const k of TIER_ORDER) sum[k] += t[k] ?? 0;
  return sceneTiers(sum);
};

/** Per-scene view of a built timeline: visual, VO timing method, captions count, music. */
export function TimelineSummary({ timeline, build, imageUrls, mixUrl }: { timeline: Timeline; build: BuildJson; imageUrls: Record<string, string>; mixUrl: string | null }) {
  const voiceById = new Map((build.voice?.scenes ?? []).map((s) => [s.sceneId, s]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{(timeline.durationFrames / timeline.fps).toFixed(1)} s</span>
        <span>· {timeline.scenes.length} cảnh</span>
        <span>· {timeline.captions.length} phụ đề</span>
        <span>· giọng {build.voice?.preset ?? "?"}</span>
        <span>· nhạc: {build.music ? `${build.music.title} (${build.music.source})` : "không"}</span>
        {build.musicError ? <Badge variant="destructive">Mubert lỗi, dùng thư viện</Badge> : null}
        {build.visuals ? <span>· hình: {tierSummary(build.visuals.perScene)}</span> : null}
        {build.stockEnabled === false ? <Badge variant="outline">stock tắt / chưa có key Pexels·Pixabay</Badge> : null}
        {build.webVideo && !build.webVideo.enabled && build.webVideo.reason !== "đủ ảnh" ? <Badge variant="outline">video web: {build.webVideo.reason}</Badge> : null}
        {build.webVideo?.enabled ? <span>· video web: {build.webVideo.assets.length} clip / {build.webVideo.searched} tìm thấy</span> : null}
        {build.framing?.enabled ? (
          <span>
            · khuôn mặt: {build.framing.withFaces}/{build.framing.checked} ảnh có mặt, căn lại {build.framing.reframed}, loại {build.framing.rejected.length}
          </span>
        ) : null}
        {build.framing?.forced.length ? <Badge variant="destructive">{build.framing.forced.length} ảnh không đạt kiểm tra khuôn mặt vẫn phải dùng</Badge> : null}
        {build.ai?.reason ? <Badge variant="outline">AI: {build.ai.reason}</Badge> : null}
        {build.mix?.integratedLufs != null ? <span>· mix {build.mix.integratedLufs.toFixed(1)} LUFS</span> : null}
      </div>
      {mixUrl ? <audio controls preload="none" src={mixUrl} className="w-full" /> : null}
      <div className="grid gap-2">
        {timeline.scenes.map((sc) => {
          const v = voiceById.get(sc.id);
          const st = build.stock?.[sc.id];
          const tiers = build.visuals?.perScene[sc.id];
          const thumb = sc.visual.kind === "solid" ? null : (st?.selected?.thumbnailUrl ?? imageUrls[sc.visual.src] ?? null);
          return (
            <div key={sc.id} className="flex gap-3 rounded-md border p-2 text-sm">
              <div className="h-24 w-14 shrink-0 overflow-hidden rounded bg-muted">
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">màu nền</div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline">{sc.id}</Badge>
                  <Badge variant="secondary">{sc.kind}</Badge>
                  <span className="text-xs text-muted-foreground">{(sc.durationFrames / timeline.fps).toFixed(1)} s</span>
                  {v ? <Badge variant={v.timing === "proportional" ? "destructive" : "outline"}>timing: {TIMING_LABEL[v.timing] ?? v.timing}{v.timing === "stt" ? ` ${v.matched}/${v.words}` : ""}</Badge> : null}
                </div>
                <div className="truncate font-medium">{sc.headline || <span className="text-muted-foreground">(không chữ)</span>}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {sc.visual.kind === "video" ? `Video ${st?.selected?.provider ?? ""} · ${sc.credit ?? ""}` : sc.visual.kind === "image" ? (sc.credit ?? "Ảnh") : "Nền màu thương hiệu"}
                  {tiers ? ` · ${sceneTiers(tiers)}` : ""}
                  {st?.searched ? ` · ${st.searched} ứng viên, ${st.alternates.length} dự phòng` : ""}
                  {v?.pronunciations.length ? ` · phát âm: ${v.pronunciations.join(", ")}` : ""}
                </div>
                {st?.errors?.length ? <div className="truncate text-xs text-destructive">{st.errors[0]}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
