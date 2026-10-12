import { listSoundCollections } from "@/lib/media/sound-collections";
import { presignMap } from "@/lib/media/timeline-resolve";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { SoundLibrary } from "./sound-library";

export const dynamic = "force-dynamic";
// Adding sounds downloads up to ten files from the source and copies them to R2 inside the server action.
export const maxDuration = 300;

/**
 * Sound library: search open-licence sounds on Openverse (Jamendo, Freesound, Wikimedia Commons), import Pixabay
 * Music tracks and one's own files, and keep them in collections the editor offers as background music.
 */
export default async function SoundsPage({ searchParams }: { searchParams: Promise<{ tab?: string; c?: string }> }) {
  const ws = await requireWorkspace();
  const sp = await searchParams;
  // Before migration 0029 is applied the tables do not exist: say so instead of failing the page.
  const collections = await listSoundCollections(ws).catch(() => null);
  if (!collections)
    return <p className="mx-auto max-w-xl rounded-xl border bg-card px-5 py-8 text-center text-sm text-muted-foreground">Thư viện âm thanh chưa sẵn sàng: cơ sở dữ liệu chưa được cập nhật (migration 0029). Báo admin chạy «pnpm db:migrate».</p>;
  const urls = await presignMap(collections.flatMap((c) => c.items.map((i) => i.key)), 3600);
  return (
    <div className="mx-auto max-w-7xl">
      <SoundLibrary
        collections={collections}
        urls={urls}
        canWrite={canWrite(ws)}
        initialTab={sp.tab === "collections" ? "collections" : "browse"}
        initialCollectionId={sp.c && collections.some((c) => c.id === sp.c) ? sp.c : null}
      />
    </div>
  );
}
