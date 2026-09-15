import "server-only";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { deleteObject, r2Key } from "@/lib/r2";
import { rankCandidates } from "./rank";
import { downloadToR2, searchStock, type StockCandidate } from "./stock";

export type ChosenAsset = { assetId: string; key: string; kind: "video" | "image"; durationSec: number | null; credit: string | null; provider: string; thumbnailUrl: string | null };
export type SceneStock = { selected: ChosenAsset | null; alternates: ChosenAsset[]; searched: number; errors: string[]; rankCostUsd: number };

const ext = (url: string, fallback: string) => {
  const m = /\.(jpe?g|png|webp|mp4|mov)(?:$|\?)/i.exec(url);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : fallback;
};

/**
 * Stock B-roll for one scene (docs/PLAN.md §4.3): search every enabled
 * provider for the scene's English terms, let Haiku rank the thumbnails,
 * download the best `keep` clips to R2 and record them as assets, deduped
 * org-wide by provider id first (no download) and then by content hash.
 * Shared by the pipeline build and the editor's per-scene regeneration.
 */
export async function fetchSceneBroll(
  scene: { id: string; voiceover: string; onScreenText: string; brollTerms: string[] },
  opts: { wantSec: number; buildId: string; keep?: number; exclude?: Set<string> },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<SceneStock> {
  const { organizationId, projectId } = ctx;
  const keep = opts.keep ?? 2;
  const { candidates: found, errors } = await searchStock(scene.brollTerms.slice(0, 3), { perTerm: 4, wantSec: opts.wantSec });
  const candidates = opts.exclude ? found.filter((c) => !opts.exclude!.has(`${c.provider}:${c.providerId}`)) : found;
  if (candidates.length === 0) return { selected: null, alternates: [], searched: 0, errors, rankCostUsd: 0 };
  let ranked: Array<StockCandidate & { score: number; reason: string }>;
  let rankCostUsd = 0;
  try {
    const r = await rankCandidates({ voiceover: scene.voiceover, onScreenText: scene.onScreenText, brollTerms: scene.brollTerms }, candidates.slice(0, 8), ctx);
    ranked = r.ranked;
    rankCostUsd = r.costUsd;
  } catch (e) {
    errors.push(`rank: ${(e as Error).message}`);
    ranked = candidates.slice(0, 8).map((c) => ({ ...c, score: 0, reason: "unranked" }));
  }
  const chosen: ChosenAsset[] = [];
  for (const c of ranked) {
    if (chosen.length >= keep) break;
    if (c.score < 15 && chosen.length > 0) break;
    try {
      const existing = await withOrgContext(ctx, (tx) =>
        tx.query.assets.findFirst({ where: and(eq(schema.assets.organizationId, organizationId), eq(schema.assets.provider, c.provider), eq(schema.assets.providerId, c.providerId)) }),
      );
      let key = existing?.r2Path ?? r2Key.media(organizationId, projectId, `broll/${opts.buildId}-${scene.id}-${c.provider}-${c.providerId}.${ext(c.downloadUrl, "mp4")}`);
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
            width: c.width, height: c.height, durationSec: c.durationSec.toFixed(2), sizeBytes, searchTerm: c.searchTerm, rankScore: c.score.toFixed(2), rankReason: c.reason, sceneId: scene.id, selected: chosen.length === 0, thumbnailUrl: c.thumbnailUrl, attribution: credit,
            meta: { buildId: opts.buildId, author: c.author },
          })
          .returning({ id: schema.assets.id }),
      );
      chosen.push({ assetId: row.id, key, kind: "video", durationSec: c.durationSec, credit, provider: c.provider, thumbnailUrl: c.thumbnailUrl });
    } catch (e) {
      errors.push(`${c.provider}:${c.providerId}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { selected: chosen[0] ?? null, alternates: chosen.slice(1), searched: candidates.length, errors, rankCostUsd };
}
