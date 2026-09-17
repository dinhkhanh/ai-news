import "server-only";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { putObject, r2Key } from "@/lib/r2";

/**
 * Logos belong to social channels (`channels.logo_path`), not to brand kits: a
 * kit is one look shared by every channel, and the same video is rendered once
 * per channel with that channel's logo. The kit keeps a logo of its own only
 * for the preview at /app/brand and as the fallback when no channel (or a
 * channel without a logo) is chosen.
 */
type Ctx = { userId: string; organizationId: string };
export type LogoChannel = { id: string; name: string; platform: string; logoPath: string };

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Validate and store an uploaded logo under library/brand/<org>/; returns the R2 key. Old files stay: renders reference them. */
export async function storeLogo(file: File, organizationId: string, name: string) {
  if (file.size > LOGO_MAX_BYTES) throw new Error("Logo must be under 2 MB");
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error("Logo must be PNG, JPEG, WebP or SVG");
  const ext = file.type === "image/svg+xml" ? "svg" : file.type.split("/")[1].replace("jpeg", "jpg");
  return putObject(r2Key.library(`brand/${organizationId}/${name}-${Date.now()}.${ext}`), Buffer.from(await file.arrayBuffer()), file.type);
}

/** Channels of the workspace that have a logo, for the pickers (every member may use them; publishing stays grant-based). */
export async function listLogoChannels(ctx: Ctx): Promise<LogoChannel[]> {
  const rows = await withOrgContext(ctx, (tx) =>
    tx
      .select({ id: schema.channels.id, name: schema.channels.name, platform: schema.channels.platform, logoPath: schema.channels.logoPath })
      .from(schema.channels)
      .where(and(eq(schema.channels.organizationId, ctx.organizationId), isNotNull(schema.channels.logoPath)))
      .orderBy(asc(schema.channels.platform), asc(schema.channels.name)),
  );
  return rows.flatMap((r) => (r.logoPath ? [{ ...r, logoPath: r.logoPath }] : []));
}

/** The logo of one channel of this workspace; null when the channel is gone or has none (callers fall back to the kit's logo). */
export async function channelLogo(ctx: Ctx, channelId: string | null | undefined): Promise<LogoChannel | null> {
  if (!channelId) return null;
  return (await listLogoChannels(ctx)).find((c) => c.id === channelId) ?? null;
}
