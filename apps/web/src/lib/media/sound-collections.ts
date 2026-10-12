import "server-only";
import { asc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { canWrite, type Workspace } from "@/lib/workspace";
import { canManagePlugins } from "@/lib/editor-plugins";
import {
  canEditCollection,
  canManageCollection,
  canSeeCollection,
  isSoundKind,
  soundCredit,
  sourceLabel,
  type CollectionActor,
  type CollectionItemView,
  type CollectionView,
  type SoundProvider,
} from "./sound-library";

export const collectionActor = (ws: Workspace): CollectionActor => ({ userId: ws.userId, canWrite: canWrite(ws), canManageWorkspace: canManagePlugins(ws) });

export function itemView(r: typeof schema.soundCollectionItems.$inferSelect): CollectionItemView {
  const kind = isSoundKind(r.kind) ? r.kind : "other";
  const label = sourceLabel(r.source);
  return {
    id: r.id,
    collectionId: r.collectionId,
    provider: r.provider as SoundProvider,
    providerId: r.providerId,
    source: r.source,
    sourceLabel: label,
    title: r.title,
    creator: r.creator,
    creatorUrl: r.creatorUrl,
    landingUrl: r.landingUrl,
    licence: r.licence,
    licenceVersion: r.licenceVersion,
    licenceUrl: r.licenceUrl,
    kind,
    durationSec: r.durationSec != null ? Number(r.durationSec) : null,
    key: r.r2Path,
    credit: soundCredit({ title: r.title, creator: r.creator, sourceLabel: label, licence: r.licence, licenceVersion: r.licenceVersion }, kind === "music" ? "music" : "sfx"),
  };
}

/** The collections this member can see (shared ones + their own private ones), oldest first, with their sounds. */
export async function listSoundCollections(ws: Workspace): Promise<CollectionView[]> {
  const actor = collectionActor(ws);
  const { cols, items } = await withOrgContext(ws, async (tx) => {
    const cols = await tx
      .select({ c: schema.soundCollections, createdByName: schema.user.name })
      .from(schema.soundCollections)
      .leftJoin(schema.user, eq(schema.user.id, schema.soundCollections.createdBy))
      .where(eq(schema.soundCollections.organizationId, ws.organizationId))
      .orderBy(asc(schema.soundCollections.createdAt));
    const items = await tx
      .select()
      .from(schema.soundCollectionItems)
      .where(eq(schema.soundCollectionItems.organizationId, ws.organizationId))
      .orderBy(asc(schema.soundCollectionItems.position), asc(schema.soundCollectionItems.createdAt));
    return { cols, items };
  });
  return cols
    .filter(({ c }) => canSeeCollection(c, actor))
    .map(({ c, createdByName }) => ({
      id: c.id,
      name: c.name,
      shared: c.shared,
      colour: c.colour,
      createdByName,
      mine: c.createdBy === ws.userId,
      canEdit: canEditCollection(c, actor),
      canManage: canManageCollection(c, actor),
      items: items.filter((i) => i.collectionId === c.id).map(itemView),
    }));
}
