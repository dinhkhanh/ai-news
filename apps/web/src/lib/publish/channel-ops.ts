import "server-only";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { storeLogo } from "@/lib/media/logo";
import { channelAccessToken, deleteChannelToken, probeToken, type ChannelRow } from "./oauth";

/**
 * Channel operations shared by /admin/channels (platform admin, any workspace)
 * and /app/channels (the member who connected the channel, workspace admins).
 * Callers authorise first and log the activity; everything here runs in the
 * service context because tokens and health columns are written by crons too.
 */

export async function loadChannelById(id: string): Promise<ChannelRow> {
  const ch = await withServiceContext((tx) => tx.query.channels.findFirst({ where: eq(schema.channels.id, id) }));
  if (!ch) throw new Error("Channel not found");
  return ch;
}

/** Grant a workspace member the right to publish to a channel; false when the user is not a member of that workspace. */
export async function grantChannelAccess(ch: Pick<ChannelRow, "id" | "organizationId">, userId: string, grantedBy: string) {
  const member = await withServiceContext((tx) => tx.query.member.findFirst({ where: and(eq(schema.member.organizationId, ch.organizationId), eq(schema.member.userId, userId)) }));
  if (!member) return false;
  await withServiceContext((tx) => tx.insert(schema.channelGrants).values({ organizationId: ch.organizationId, channelId: ch.id, userId, grantedBy }).onConflictDoNothing());
  return true;
}

export async function revokeChannelAccess(ch: ChannelRow, userId: string) {
  await withServiceContext((tx) => tx.delete(schema.channelGrants).where(and(eq(schema.channelGrants.channelId, ch.id), eq(schema.channelGrants.userId, userId))));
}

export async function setChannelEnabledState(ch: ChannelRow, enabled: boolean) {
  await withServiceContext((tx) => tx.update(schema.channels).set({ enabled }).where(eq(schema.channels.id, ch.id)));
}

/** Refresh (if needed) and probe the token now; the cron does the same every 6 h. Records the result on the channel. */
export async function checkChannelToken(ch: ChannelRow): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const token = await channelAccessToken(ch);
    await probeToken(ch.platform, token, ch.meta);
    await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: true, lastError: null, lastCheckedAt: new Date() }).where(eq(schema.channels.id, ch.id)));
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: false, lastError: error.slice(0, 1000), lastCheckedAt: new Date() }).where(eq(schema.channels.id, ch.id)));
    return { ok: false, error };
  }
}

/** Removes the token from Vault and the channel row (publications keep a restrict FK, so channels with history are paused instead). */
export async function disconnectChannelRow(ch: ChannelRow, reason: string) {
  const used = await withServiceContext((tx) => tx.query.publications.findFirst({ where: eq(schema.publications.channelId, ch.id), columns: { id: true } }));
  await deleteChannelToken(ch);
  if (used) {
    await withServiceContext((tx) => tx.update(schema.channels).set({ vaultRef: null, enabled: false, healthy: false, lastError: reason }).where(eq(schema.channels.id, ch.id)));
    await withServiceContext((tx) => tx.delete(schema.channelGrants).where(eq(schema.channelGrants.channelId, ch.id)));
  } else {
    await withServiceContext((tx) => tx.delete(schema.channels).where(eq(schema.channels.id, ch.id)));
  }
  return { kept: Boolean(used) };
}

/** The logo this channel's videos carry (brand kits are shared across channels, logos are not). Returns the new key, null when removed. */
export async function saveChannelLogo(ch: ChannelRow, file: FormDataEntryValue | null, remove: boolean) {
  const upload = file instanceof File && file.size > 0 ? file : null;
  if (!upload && !remove) throw new Error("Choose a PNG, SVG, WebP or JPEG file");
  const logoPath = upload ? await storeLogo(upload, ch.organizationId, `channel-logo-${ch.id}`) : null;
  await withServiceContext((tx) => tx.update(schema.channels).set({ logoPath }).where(eq(schema.channels.id, ch.id)));
  return logoPath;
}
