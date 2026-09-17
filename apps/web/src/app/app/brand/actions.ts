"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { BRAND_FONTS, CAPTION_FONT_RANGE, HEADLINE_FONT_RANGE, LOGO_MOTIONS, OUTPUT, type BoxShadow, type LogoMotion } from "@ai-news/video/schema";
import { nanoid } from "nanoid";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { run, str, type ActionState } from "@/lib/admin";
import { normaliseColour } from "@/lib/colour";
import { DEFAULT_BRAND } from "@/lib/media/brand";
import { parseKeywords } from "@/lib/media/brand-match";
import { storeLogo } from "@/lib/media/logo";
import { pngInfo } from "@/lib/media/png";
import { deleteObject, getObjectRange, headObject, presignGet, presignPut, r2Key } from "@/lib/r2";
import { assertWorkspaceWriter } from "@/lib/workspace";

/** `#rrggbb`, or `#rrggbbaa` for a translucent colour (the picker's opacity slider). */
const colour = (fd: FormData, key: string, fallback: string) => {
  const v = str(fd, key);
  if (!v) return fallback;
  const c = normaliseColour(v);
  if (!c) throw new Error(`${key}: use a #rrggbb or #rrggbbaa colour`);
  return c;
};
const font = (fd: FormData, key: string) => {
  const v = str(fd, key) || "Be Vietnam Pro";
  if (!(BRAND_FONTS as readonly string[]).includes(v)) throw new Error(`${key}: unsupported font`);
  return v as (typeof BRAND_FONTS)[number];
};

/** Whole px inside [min, max]; empty = null (automatic). */
const px = (fd: FormData, key: string, min: number, max: number) => {
  const v = str(fd, key);
  if (!v) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key}: a number from ${min} to ${max}, or empty for automatic`);
  return n;
};

/** Box shadow from the four `<prefix>Colour / Blur / X / Y` fields; empty numbers keep the default. */
const shadow = (fd: FormData, prefix: string, d: BoxShadow): BoxShadow => ({
  colour: colour(fd, `${prefix}Colour`, d.colour),
  blur: px(fd, `${prefix}Blur`, 0, 200) ?? d.blur,
  x: px(fd, `${prefix}X`, -200, 200) ?? d.x,
  y: px(fd, `${prefix}Y`, -200, 200) ?? d.y,
});

const OVERLAY_MAX_BYTES = 12 * 1024 * 1024;
const overlayPrefix = (org: string, kitId: string) => r2Key.library(`brand/${org}/overlay-${kitId}-`);

async function assertKitManager() {
  const w = await assertWorkspaceWriter();
  if (!["admin", "owner", "publisher"].includes(w.ws.role) && !w.ws.isAdmin) throw new Error("Only a workspace admin or publisher can edit brand kits");
  return w;
}

type Ws = Awaited<ReturnType<typeof assertKitManager>>["ws"];
async function loadKit(ws: Ws, id: string) {
  const kit = await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.id, id)) }));
  if (!kit) throw new Error("Brand kit not found in this workspace");
  return kit;
}

/** Create a kit (`id` empty) or update one. The first kit of a workspace becomes its default. */
export async function saveBrandKit(_: ActionState, fd: FormData): Promise<ActionState> {
  let created: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await assertKitManager();
    const id = str(fd, "id");
    const existing = id ? await loadKit(ws, id) : null;
    const name = str(fd, "name").slice(0, 60);
    if (name.length < 2) throw new Error("Give the kit a name that says what it is for, e.g. “Thể thao”");
    const clash = await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.name, name), ...(existing ? [ne(schema.brandKits.id, existing.id)] : [])), columns: { id: true } }));
    if (clash) throw new Error(`Another kit is already called “${name}”`);

    let logoPath = existing?.logoPath ?? null;
    const logo = fd.get("logo");
    if (logo instanceof File && logo.size > 0) {
      logoPath = await storeLogo(logo, ws.organizationId, "logo");
    }
    if (fd.get("removeLogo") === "on") logoPath = null;
    const values = {
      name,
      description: str(fd, "description").slice(0, 400),
      matchKeywords: parseKeywords(str(fd, "matchKeywords")),
      autoMatch: fd.get("autoMatch") === "on",
      logoPath,
      logoMotion: ((LOGO_MOTIONS as readonly string[]).includes(str(fd, "logoMotion")) ? str(fd, "logoMotion") : "flip") as LogoMotion,
      overlayLayer: str(fd, "overlayLayer") === "top" ? ("top" as const) : ("under_text" as const),
      fonts: { heading: font(fd, "fontHeading"), body: font(fd, "fontBody"), caption: font(fd, "fontCaption") },
      colours: {
        primary: colour(fd, "primary", DEFAULT_BRAND.colours.primary),
        accent: colour(fd, "accent", DEFAULT_BRAND.colours.accent),
        background: colour(fd, "background", DEFAULT_BRAND.colours.background),
        text: colour(fd, "text", DEFAULT_BRAND.colours.text),
        captionHighlight: colour(fd, "captionHighlight", DEFAULT_BRAND.colours.captionHighlight),
        captionBg: colour(fd, "captionBg", DEFAULT_BRAND.colours.captionBg),
      },
      captionStyle: {
        position: str(fd, "captionPosition") === "middle" ? "middle" : "bottom",
        fontSize: px(fd, "captionFontSize", CAPTION_FONT_RANGE.min, CAPTION_FONT_RANGE.max) ?? DEFAULT_BRAND.caption.fontSize,
        align: str(fd, "captionAlign") === "left" ? "left" : "center",
        shadow: shadow(fd, "captionShadow", DEFAULT_BRAND.caption.shadow),
        uppercase: fd.get("captionUppercase") === "on",
        highlightWords: fd.get("captionHighlightWords") === "on",
        x: px(fd, "captionX", 0, OUTPUT.width),
        y: px(fd, "captionY", 0, OUTPUT.height),
      },
      headlineStyle: { fontSize: px(fd, "headlineFontSize", HEADLINE_FONT_RANGE.min, HEADLINE_FONT_RANGE.max) ?? DEFAULT_BRAND.headline.fontSize, shadow: shadow(fd, "headlineShadow", DEFAULT_BRAND.headline.shadow), x: px(fd, "headlineX", 0, OUTPUT.width), y: px(fd, "headlineY", 0, OUTPUT.height) },
      lowerThird: { showSource: fd.get("showSource") === "on", outroText: str(fd, "outroText") || null },
      safeZones: { top: 220, bottom: 420, left: 60, right: 180 },
    };
    await withOrgContext(ws, async (tx) => {
      if (existing) return void (await tx.update(schema.brandKits).set(values).where(eq(schema.brandKits.id, existing.id)));
      const hasDefault = await tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.isDefault, true)), columns: { id: true } });
      const [row] = await tx.insert(schema.brandKits).values({ ...values, organizationId: ws.organizationId, isDefault: !hasDefault }).returning({ id: schema.brandKits.id });
      created = row.id;
    });
    await log(existing ? "brand_kit.saved" : "brand_kit.created", { kitId: existing?.id ?? created, name, logo: Boolean(logoPath), keywords: values.matchKeywords.length, autoMatch: values.autoMatch });
    revalidatePath("/app/brand");
    return existing ? `Đã lưu “${name}”; lần dựng timeline tiếp theo dùng bản mới` : `Đã tạo “${name}”. Giờ có thể tải lớp phủ PNG lên.`;
  });
  if (created) redirect(`/app/brand?kit=${created}`);
  return state;
}

/** The kit used when nothing matches an article and none was picked by hand. */
export async function setDefaultBrandKit(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertKitManager();
    const kit = await loadKit(ws, str(fd, "id"));
    await withOrgContext(ws, async (tx) => {
      // Demote first: the partial unique index allows one default per workspace.
      await tx.update(schema.brandKits).set({ isDefault: false }).where(and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.isDefault, true)));
      await tx.update(schema.brandKits).set({ isDefault: true }).where(eq(schema.brandKits.id, kit.id));
    });
    await log("brand_kit.default_set", { kitId: kit.id, name: kit.name });
    revalidatePath("/app/brand");
    return `“${kit.name}” là bộ mặc định`;
  });
}

/** Copy a kit (colours, fonts, captions, logo and overlay files are shared, never the default flag or the matching rules). */
export async function duplicateBrandKit(_: ActionState, fd: FormData): Promise<ActionState> {
  let created: string | null = null;
  const state = await run(async () => {
    const { ws, log } = await assertKitManager();
    const kit = await loadKit(ws, str(fd, "id"));
    const [row] = await withOrgContext(ws, (tx) =>
      tx.insert(schema.brandKits).values({ ...kit, id: undefined, createdAt: undefined, updatedAt: undefined, name: `${kit.name} (bản sao ${nanoid(4)})`.slice(0, 60), isDefault: false, description: "", matchKeywords: [] }).returning({ id: schema.brandKits.id }),
    );
    created = row.id;
    await log("brand_kit.duplicated", { from: kit.id, kitId: row.id });
    revalidatePath("/app/brand");
    return "Đã nhân bản; đặt tên và mô tả cho bộ mới";
  });
  if (created) redirect(`/app/brand?kit=${created}`);
  return state;
}

/** Projects pointing at the kit fall back to the default (FK `on delete set null`); stored timelines keep their embedded copy. */
export async function deleteBrandKit(_: ActionState, fd: FormData): Promise<ActionState> {
  const state = await run(async () => {
    const { ws, log } = await assertKitManager();
    const kit = await loadKit(ws, str(fd, "id"));
    if (fd.get("confirm") !== "on") throw new Error("Tick “xác nhận xoá” first");
    if (kit.isDefault) throw new Error("Chọn bộ mặc định khác trước khi xoá bộ này");
    await withOrgContext(ws, (tx) => tx.delete(schema.brandKits).where(eq(schema.brandKits.id, kit.id)));
    // The logo / overlay files stay in R2: timeline versions built with this kit still reference them.
    await log("brand_kit.deleted", { kitId: kit.id, name: kit.name });
    revalidatePath("/app/brand");
    return `Đã xoá “${kit.name}”`;
  });
  if (state.ok) redirect("/app/brand");
  return state;
}

/* ------------------------------------------------------------ overlay PNG */

export type OverlayTicket = { ok: true; key: string; url: string } | { ok: false; message: string };
export type OverlaySaved = { ok: true; url: string; message: string } | { ok: false; message: string };
const fail = (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : "Something went wrong" });

/** Presigned PUT for the overlay, browser → R2 (a full-frame PNG is often larger than a server action body may be). */
export async function createOverlayUploadUrl(input: { kitId: string; sizeBytes: number; contentType: string }): Promise<OverlayTicket> {
  try {
    const { ws } = await assertKitManager();
    const kit = await loadKit(ws, input.kitId);
    if (input.contentType !== "image/png") throw new Error("Lớp phủ phải là tệp PNG (nền trong suốt)");
    if (!(input.sizeBytes > 0) || input.sizeBytes > OVERLAY_MAX_BYTES) throw new Error("PNG tối đa 12 MB");
    const key = `${overlayPrefix(ws.organizationId, kit.id)}${nanoid(8)}.png`;
    return { ok: true, key, url: await presignPut(key, "image/png", 900) };
  } catch (e) {
    return fail(e);
  }
}

/** After the browser PUT: the file must really be a 1080×1920 PNG that can be transparent, else it is deleted again. */
export async function registerOverlay(input: { kitId: string; key: string }): Promise<OverlaySaved> {
  try {
    const { ws, log } = await assertKitManager();
    const kit = await loadKit(ws, input.kitId);
    if (!input.key.startsWith(overlayPrefix(ws.organizationId, kit.id)) || !input.key.endsWith(".png")) throw new Error("Khoá tệp không hợp lệ");
    const head = await headObject(input.key);
    if (!head.exists || head.size === 0) throw new Error("Tệp chưa được tải lên xong");
    const reject = async (message: string) => {
      await deleteObject(input.key).catch(() => {});
      return new Error(message);
    };
    if (head.size > OVERLAY_MAX_BYTES) throw await reject("PNG tối đa 12 MB");
    const info = pngInfo(await getObjectRange(input.key, 0, Math.min(head.size, 65_536) - 1));
    if (!info) throw await reject("Tệp không phải PNG");
    if (info.width !== OUTPUT.width || info.height !== OUTPUT.height) throw await reject(`Lớp phủ phải đúng ${OUTPUT.width}×${OUTPUT.height} px (tệp này ${info.width}×${info.height})`);
    if (!info.hasAlpha) throw await reject("PNG này không có kênh trong suốt nên sẽ che kín video. Xuất lại với nền trong suốt (RGBA).");
    await withOrgContext(ws, (tx) => tx.update(schema.brandKits).set({ overlayPath: input.key }).where(eq(schema.brandKits.id, kit.id)));
    // The previous file is kept: timeline versions built with it still reference the key.
    await log("brand_kit.overlay_set", { kitId: kit.id, name: kit.name, key: input.key, sizeBytes: head.size });
    revalidatePath("/app/brand");
    return { ok: true, url: await presignGet(input.key, 600), message: "Đã lưu lớp phủ; lần dựng timeline tiếp theo sẽ dùng" };
  } catch (e) {
    return fail(e);
  }
}

export async function removeOverlay(input: { kitId: string }): Promise<{ ok: boolean; message: string }> {
  try {
    const { ws, log } = await assertKitManager();
    const kit = await loadKit(ws, input.kitId);
    await withOrgContext(ws, (tx) => tx.update(schema.brandKits).set({ overlayPath: null }).where(eq(schema.brandKits.id, kit.id)));
    await log("brand_kit.overlay_removed", { kitId: kit.id, name: kit.name });
    revalidatePath("/app/brand");
    return { ok: true, message: "Đã gỡ lớp phủ khỏi bộ này" };
  } catch (e) {
    return fail(e);
  }
}
