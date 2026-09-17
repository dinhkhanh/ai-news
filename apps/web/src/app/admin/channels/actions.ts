"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { storeLogo } from "@/lib/media/logo";
import { channelAccessToken, deleteChannelToken, probeToken } from "@/lib/publish/oauth";
import { pullChannelAnalytics } from "@/lib/publish/service";

async function loadChannel(id: string) {
  const ch = await withServiceContext((tx) => tx.query.channels.findFirst({ where: eq(schema.channels.id, id) }));
  if (!ch) throw new Error("Channel not found");
  return ch;
}

/** Grant a workspace member the right to publish to a channel (docs/PLAN.md §1 "granted to users"). */
export async function grantChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const channelId = str(fd, "channelId");
    const userId = str(fd, "userId");
    const ch = await loadChannel(channelId);
    const member = await withServiceContext((tx) => tx.query.member.findFirst({ where: and(eq(schema.member.organizationId, ch.organizationId), eq(schema.member.userId, userId)) }));
    if (!member) throw new Error("User is not a member of that workspace");
    await withServiceContext((tx) => tx.insert(schema.channelGrants).values({ organizationId: ch.organizationId, channelId, userId, grantedBy: session.user.id }).onConflictDoNothing());
    await log("channel.granted", { channelId, userId, platform: ch.platform }, { organizationId: ch.organizationId });
    revalidatePath("/admin/channels");
    return "Granted";
  });
}

export async function revokeChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const channelId = str(fd, "channelId");
    const userId = str(fd, "userId");
    const ch = await loadChannel(channelId);
    await withServiceContext((tx) => tx.delete(schema.channelGrants).where(and(eq(schema.channelGrants.channelId, channelId), eq(schema.channelGrants.userId, userId))));
    await log("channel.revoked", { channelId, userId, platform: ch.platform }, { organizationId: ch.organizationId });
    revalidatePath("/admin/channels");
    return "Revoked";
  });
}

export async function setChannelEnabled(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const channelId = str(fd, "channelId");
    const enabled = str(fd, "enabled") === "1";
    const ch = await loadChannel(channelId);
    await withServiceContext((tx) => tx.update(schema.channels).set({ enabled }).where(eq(schema.channels.id, channelId)));
    await log(enabled ? "channel.enabled" : "channel.paused", { channelId, platform: ch.platform }, { organizationId: ch.organizationId });
    revalidatePath("/admin/channels");
    return enabled ? "Channel enabled" : "Channel paused";
  });
}

/** Refresh (if needed) and probe the token now; the cron does the same every 6 h. */
export async function checkChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const channelId = str(fd, "channelId");
    const ch = await loadChannel(channelId);
    try {
      const token = await channelAccessToken(ch);
      await probeToken(ch.platform, token, ch.meta);
      await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: true, lastError: null, lastCheckedAt: new Date() }).where(eq(schema.channels.id, channelId)));
      await log("channel.checked", { channelId, platform: ch.platform, ok: true }, { organizationId: ch.organizationId });
      revalidatePath("/admin/channels");
      return `${ch.name}: token OK`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withServiceContext((tx) => tx.update(schema.channels).set({ healthy: false, lastError: message.slice(0, 1000), lastCheckedAt: new Date() }).where(eq(schema.channels.id, channelId)));
      await log("channel.checked", { channelId, platform: ch.platform, ok: false, error: message.slice(0, 300) }, { organizationId: ch.organizationId });
      revalidatePath("/admin/channels");
      throw new Error(`${ch.name}: ${message}`);
    }
  });
}

export async function pullAnalyticsNow(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const channelId = str(fd, "channelId");
    const ch = await loadChannel(channelId);
    const res = await pullChannelAnalytics(channelId);
    await log("analytics.pulled", { ...res }, { organizationId: ch.organizationId });
    revalidatePath("/admin/channels");
    revalidatePath("/admin/analytics");
    if (res.error) throw new Error(res.error);
    return `Pulled analytics for ${res.pulled} post(s)`;
  });
}

/** Disconnect: removes the token from Vault and the channel row (publications keep a restrict FK, so channels with history are paused instead). */
export async function disconnectChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const channelId = str(fd, "channelId");
    const ch = await loadChannel(channelId);
    const used = await withServiceContext((tx) => tx.query.publications.findFirst({ where: eq(schema.publications.channelId, channelId), columns: { id: true } }));
    await deleteChannelToken(ch);
    if (used) {
      await withServiceContext((tx) => tx.update(schema.channels).set({ vaultRef: null, enabled: false, healthy: false, lastError: "Disconnected by admin" }).where(eq(schema.channels.id, channelId)));
      await withServiceContext((tx) => tx.delete(schema.channelGrants).where(eq(schema.channelGrants.channelId, channelId)));
    } else {
      await withServiceContext((tx) => tx.delete(schema.channels).where(eq(schema.channels.id, channelId)));
    }
    await log("channel.disconnected", { channelId, platform: ch.platform, name: ch.name, kept: Boolean(used) }, { organizationId: ch.organizationId });
    revalidatePath("/admin/channels");
    return used ? `${ch.name} disconnected (kept for publication history)` : `${ch.name} removed`;
  });
}

/** The logo this channel's videos carry (brand kits are shared across channels, logos are not). */
export async function setChannelLogo(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const ch = await loadChannel(str(fd, "channelId"));
    const remove = fd.get("remove") === "on";
    const file = fd.get("logo");
    let logoPath = ch.logoPath;
    if (file instanceof File && file.size > 0) logoPath = await storeLogo(file, ch.organizationId, `channel-logo-${ch.id}`);
    else if (!remove) throw new Error("Choose a PNG, SVG, WebP or JPEG file");
    if (remove && !(file instanceof File && file.size > 0)) logoPath = null;
    await withServiceContext((tx) => tx.update(schema.channels).set({ logoPath }).where(eq(schema.channels.id, ch.id)));
    await log(logoPath ? "channel.logo_set" : "channel.logo_removed", { channelId: ch.id, platform: ch.platform, name: ch.name }, { organizationId: ch.organizationId });
    revalidatePath("/admin/channels");
    return logoPath ? `Logo saved for ${ch.name}; the next render for this channel uses it` : `Logo removed from ${ch.name}; its videos fall back to the brand kit's logo`;
  });
}
