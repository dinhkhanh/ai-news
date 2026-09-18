"use server";
import { revalidatePath } from "next/cache";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { checkChannelToken, disconnectChannelRow, grantChannelAccess, loadChannelById, revokeChannelAccess, saveChannelLogo, setChannelEnabledState } from "@/lib/publish/channel-ops";
import { pullChannelAnalytics } from "@/lib/publish/service";

/**
 * Platform-admin side of channels, across workspaces. Members connect and manage
 * their own channels at /app/channels (src/app/app/channels/actions.ts); both
 * share the operations in src/lib/publish/channel-ops.ts.
 */
const revalidate = () => {
  revalidatePath("/admin/channels");
  revalidatePath("/app/channels");
};

/** Grant a workspace member the right to publish to a channel (docs/PLAN.md §1 "granted to users"). */
export async function grantChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const userId = str(fd, "userId");
    const ch = await loadChannelById(str(fd, "channelId"));
    if (!(await grantChannelAccess(ch, userId, session.user.id))) throw new Error("User is not a member of that workspace");
    await log("channel.granted", { channelId: ch.id, userId, platform: ch.platform }, { organizationId: ch.organizationId });
    revalidate();
    return "Granted";
  });
}

export async function revokeChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const userId = str(fd, "userId");
    const ch = await loadChannelById(str(fd, "channelId"));
    await revokeChannelAccess(ch, userId);
    await log("channel.revoked", { channelId: ch.id, userId, platform: ch.platform }, { organizationId: ch.organizationId });
    revalidate();
    return "Revoked";
  });
}

export async function setChannelEnabled(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const enabled = str(fd, "enabled") === "1";
    const ch = await loadChannelById(str(fd, "channelId"));
    await setChannelEnabledState(ch, enabled);
    await log(enabled ? "channel.enabled" : "channel.paused", { channelId: ch.id, platform: ch.platform }, { organizationId: ch.organizationId });
    revalidate();
    return enabled ? "Channel enabled" : "Channel paused";
  });
}

/** Refresh (if needed) and probe the token now; the cron does the same every 6 h. */
export async function checkChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const ch = await loadChannelById(str(fd, "channelId"));
    const res = await checkChannelToken(ch);
    await log("channel.checked", { channelId: ch.id, platform: ch.platform, ok: res.ok, ...(res.ok ? {} : { error: res.error.slice(0, 300) }) }, { organizationId: ch.organizationId });
    revalidate();
    if (!res.ok) throw new Error(`${ch.name}: ${res.error}`);
    return `${ch.name}: token OK`;
  });
}

export async function pullAnalyticsNow(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const ch = await loadChannelById(str(fd, "channelId"));
    const res = await pullChannelAnalytics(ch.id);
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
    const ch = await loadChannelById(str(fd, "channelId"));
    const { kept } = await disconnectChannelRow(ch, "Disconnected by admin");
    await log("channel.disconnected", { channelId: ch.id, platform: ch.platform, name: ch.name, kept }, { organizationId: ch.organizationId });
    revalidate();
    return kept ? `${ch.name} disconnected (kept for publication history)` : `${ch.name} removed`;
  });
}

/** The logo this channel's videos carry (brand kits are shared across channels, logos are not). */
export async function setChannelLogo(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const ch = await loadChannelById(str(fd, "channelId"));
    const logoPath = await saveChannelLogo(ch, fd.get("logo"), fd.get("remove") === "on");
    await log(logoPath ? "channel.logo_set" : "channel.logo_removed", { channelId: ch.id, platform: ch.platform, name: ch.name }, { organizationId: ch.organizationId });
    revalidate();
    return logoPath ? `Logo saved for ${ch.name}; the next render for this channel uses it` : `Logo removed from ${ch.name}; its videos fall back to the brand kit's logo`;
  });
}
