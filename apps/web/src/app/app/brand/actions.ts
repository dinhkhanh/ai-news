"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { BRAND_FONTS } from "@ai-news/video/schema";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { run, str, type ActionState } from "@/lib/admin";
import { DEFAULT_BRAND } from "@/lib/media/brand";
import { putObject, r2Key } from "@/lib/r2";
import { assertWorkspaceWriter } from "@/lib/workspace";

const HEX = /^#[0-9a-fA-F]{6}$/;
const colour = (fd: FormData, key: string, fallback: string) => {
  const v = str(fd, key);
  if (!v) return fallback;
  if (!HEX.test(v)) throw new Error(`${key}: use a #rrggbb colour`);
  return v;
};
const font = (fd: FormData, key: string) => {
  const v = str(fd, key) || "Be Vietnam Pro";
  if (!(BRAND_FONTS as readonly string[]).includes(v)) throw new Error(`${key}: unsupported font`);
  return v as (typeof BRAND_FONTS)[number];
};

/** Create/update the workspace's default brand kit (docs/PLAN.md §4.6 brand kit + safe zones). */
export async function saveBrandKit(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    if (!["admin", "owner", "publisher"].includes(ws.role) && !ws.isAdmin) throw new Error("Only a workspace admin or publisher can edit the brand kit");
    const existing = await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.isDefault, true)) }));
    let logoPath = existing?.logoPath ?? null;
    const logo = fd.get("logo");
    if (logo instanceof File && logo.size > 0) {
      if (logo.size > 2 * 1024 * 1024) throw new Error("Logo must be under 2 MB");
      if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(logo.type)) throw new Error("Logo must be PNG, JPEG, WebP or SVG");
      const ext = logo.type === "image/svg+xml" ? "svg" : logo.type.split("/")[1].replace("jpeg", "jpg");
      logoPath = await putObject(r2Key.library(`brand/${ws.organizationId}/logo-${Date.now()}.${ext}`), Buffer.from(await logo.arrayBuffer()), logo.type);
    }
    if (fd.get("removeLogo") === "on") logoPath = null;
    const values = {
      organizationId: ws.organizationId,
      name: str(fd, "name") || "Brand kit",
      isDefault: true,
      logoPath,
      fonts: { heading: font(fd, "fontHeading"), body: font(fd, "fontBody"), caption: font(fd, "fontCaption") },
      colours: {
        primary: colour(fd, "primary", DEFAULT_BRAND.colours.primary),
        accent: colour(fd, "accent", DEFAULT_BRAND.colours.accent),
        background: colour(fd, "background", DEFAULT_BRAND.colours.background),
        text: colour(fd, "text", DEFAULT_BRAND.colours.text),
        captionHighlight: colour(fd, "captionHighlight", DEFAULT_BRAND.colours.captionHighlight),
        captionBg: DEFAULT_BRAND.colours.captionBg,
      },
      captionStyle: {
        position: str(fd, "captionPosition") === "middle" ? "middle" : "bottom",
        fontSize: Math.min(96, Math.max(36, Number(str(fd, "captionFontSize") || 64))),
        uppercase: fd.get("captionUppercase") === "on",
        highlightWords: fd.get("captionHighlightWords") === "on",
      },
      lowerThird: { showSource: fd.get("showSource") === "on", outroText: str(fd, "outroText") || null },
      safeZones: { top: 220, bottom: 420, left: 60, right: 180 },
    };
    await withOrgContext(ws, async (tx) => {
      if (existing) await tx.update(schema.brandKits).set(values).where(eq(schema.brandKits.id, existing.id));
      else await tx.insert(schema.brandKits).values(values);
    });
    await log("brand_kit.saved", { name: values.name, logo: Boolean(logoPath) });
    revalidatePath("/app/brand");
    return "Brand kit saved; the next timeline build uses it";
  });
}
