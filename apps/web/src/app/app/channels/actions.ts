"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { run, str, type ActionState } from "@/lib/admin";
import { canManageChannel } from "@/lib/publish/channel-access";
import { checkChannelToken, disconnectChannelRow, grantChannelAccess, revokeChannelAccess, saveChannelLogo, setChannelEnabledState } from "@/lib/publish/channel-ops";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * Member side of channels: whoever connected a channel (and the workspace's
 * admins) manages it here. The channel is read inside the org context, so a
 * channel of another workspace is simply "not found".
 */
const revalidate = () => {
  revalidatePath("/app/channels");
  revalidatePath("/admin/channels");
};

async function assertChannelManager(fd: FormData) {
  const w = await assertWorkspaceWriter();
  const channelId = str(fd, "channelId");
  const ch = await withOrgContext(w.ws, (tx) => tx.query.channels.findFirst({ where: and(eq(schema.channels.id, channelId), eq(schema.channels.organizationId, w.ws.organizationId)) }));
  if (!ch) throw new Error("Không tìm thấy kênh trong workspace này");
  if (!canManageChannel(w.ws, ch)) throw new Error("Chỉ người đã kết nối kênh này hoặc admin workspace mới quản lý được kênh");
  return { ...w, ch };
}

/** Let a colleague of the workspace publish to a channel. */
export async function grantMyChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, ch, log } = await assertChannelManager(fd);
    const userId = str(fd, "userId");
    if (!(await grantChannelAccess(ch, userId, ws.userId))) throw new Error("Người này không thuộc workspace");
    await log("channel.granted", { channelId: ch.id, userId, platform: ch.platform });
    revalidate();
    return "Đã cấp quyền đăng";
  });
}

export async function revokeMyChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ch, log } = await assertChannelManager(fd);
    const userId = str(fd, "userId");
    await revokeChannelAccess(ch, userId);
    await log("channel.revoked", { channelId: ch.id, userId, platform: ch.platform });
    revalidate();
    return "Đã thu hồi quyền đăng";
  });
}

export async function setMyChannelEnabled(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ch, log } = await assertChannelManager(fd);
    const enabled = str(fd, "enabled") === "1";
    await setChannelEnabledState(ch, enabled);
    await log(enabled ? "channel.enabled" : "channel.paused", { channelId: ch.id, platform: ch.platform });
    revalidate();
    return enabled ? "Đã bật lại kênh" : "Đã tạm dừng kênh";
  });
}

export async function checkMyChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ch, log } = await assertChannelManager(fd);
    const res = await checkChannelToken(ch);
    await log("channel.checked", { channelId: ch.id, platform: ch.platform, ok: res.ok, ...(res.ok ? {} : { error: res.error.slice(0, 300) }) });
    revalidate();
    if (!res.ok) throw new Error(`${ch.name}: ${res.error}. Hãy kết nối lại kênh.`);
    return `${ch.name}: kết nối vẫn hoạt động`;
  });
}

export async function disconnectMyChannel(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ch, log } = await assertChannelManager(fd);
    const { kept } = await disconnectChannelRow(ch, "Disconnected by a workspace member");
    await log("channel.disconnected", { channelId: ch.id, platform: ch.platform, name: ch.name, kept });
    revalidate();
    return kept ? `Đã ngắt kết nối ${ch.name} (giữ lại để xem lịch sử đăng)` : `Đã xoá kênh ${ch.name}`;
  });
}

export async function setMyChannelLogo(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ch, log } = await assertChannelManager(fd);
    const file = fd.get("logo");
    const remove = fd.get("remove") === "on";
    if (!remove && !(file instanceof File && file.size > 0)) throw new Error("Hãy chọn tệp PNG, SVG, WebP hoặc JPEG");
    const logoPath = await saveChannelLogo(ch, file, remove);
    await log(logoPath ? "channel.logo_set" : "channel.logo_removed", { channelId: ch.id, platform: ch.platform, name: ch.name });
    revalidate();
    return logoPath ? `Đã lưu logo cho ${ch.name}; lần kết xuất tới cho kênh này sẽ dùng logo mới` : `Đã gỡ logo của ${ch.name}; video dùng logo của bộ nhận diện`;
  });
}
