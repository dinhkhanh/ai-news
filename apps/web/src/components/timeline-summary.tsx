import type { Timeline } from "@ai-news/video/schema";
import { Badge } from "@/components/ui/badge";

type SceneBuild = { sceneId: string; durationMs: number; timing: string; matched: number; words: number; chars: number; pronunciations: string[] };
type StockBuild = { selected: { provider: string; credit: string | null; thumbnailUrl: string | null; durationSec: number | null } | null; alternates: unknown[]; searched: number; errors: string[] };
export type BuildJson = {
  voice?: { preset: string; scenes: SceneBuild[] };
  stock?: Record<string, StockBuild>;
  stockEnabled?: boolean;
  music?: { source: string; title: string; licence: string } | null;
  musicError?: string | null;
  mix?: { integratedLufs: number | null };
};

const TIMING_LABEL: Record<string, string> = { ssml: "mốc SSML", stt: "STT", proportional: "ước lượng" };

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
        {build.stockEnabled === false ? <Badge variant="outline">chưa có key Pexels/Pixabay → dùng ảnh bài</Badge> : null}
        {build.mix?.integratedLufs != null ? <span>· mix {build.mix.integratedLufs.toFixed(1)} LUFS</span> : null}
      </div>
      {mixUrl ? <audio controls preload="none" src={mixUrl} className="w-full" /> : null}
      <div className="grid gap-2">
        {timeline.scenes.map((sc) => {
          const v = voiceById.get(sc.id);
          const st = build.stock?.[sc.id];
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
                  {sc.visual.kind === "video" ? `Video ${st?.selected?.provider ?? ""} · ${sc.credit ?? ""}` : sc.visual.kind === "image" ? `Ảnh bài báo · ${sc.credit ?? ""}` : "Nền màu thương hiệu"}
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
