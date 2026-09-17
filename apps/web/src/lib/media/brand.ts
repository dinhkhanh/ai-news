import "server-only";
import { brandSchema, LOGO_MOTIONS, OVERLAY_LAYERS, type Brand } from "@ai-news/video/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { pickBrandKit } from "@/lib/llm/pick-brand-kit";
import { pickKitByKeywords, type KitCandidate } from "./brand-match";

/** Platform default brand kit (used until a workspace defines one at /app/brand). */
export const DEFAULT_BRAND: Brand = brandSchema.parse({ colours: {}, fonts: {}, caption: {} });

export type BrandKitRow = typeof schema.brandKits.$inferSelect;
type Ctx = { userId: string; organizationId: string };

/** Map a brand_kits row to the timeline's embedded brand (logo and overlay stay R2 keys here). */
export function brandFromRow(row: BrandKitRow | null | undefined): { brand: Brand; logoKey: string | null; id: string | null } {
  if (!row) return { brand: DEFAULT_BRAND, logoKey: null, id: null };
  const cs = row.captionStyle as Partial<Brand["caption"]>;
  const brand = brandSchema.parse({
    name: row.name,
    colours: { ...DEFAULT_BRAND.colours, ...row.colours },
    fonts: { ...DEFAULT_BRAND.fonts, ...row.fonts },
    caption: { ...DEFAULT_BRAND.caption, ...cs },
    logoSrc: row.logoPath,
    logoMotion: (LOGO_MOTIONS as readonly string[]).includes(row.logoMotion) ? row.logoMotion : "flip",
    overlaySrc: row.overlayPath,
    overlayLayer: (OVERLAY_LAYERS as readonly string[]).includes(row.overlayLayer) ? row.overlayLayer : "under_text",
    showSource: (row.lowerThird as { showSource?: boolean } | null)?.showSource ?? true,
    outroText: (row.lowerThird as { outroText?: string | null } | null)?.outroText ?? null,
  });
  return { brand, logoKey: row.logoPath, id: row.id };
}

/** Every kit of the workspace: the default first, then by name. */
export function listBrandKits(ctx: Ctx): Promise<BrandKitRow[]> {
  return withOrgContext(ctx, (tx) => tx.query.brandKits.findMany({ where: eq(schema.brandKits.organizationId, ctx.organizationId), orderBy: [desc(schema.brandKits.isDefault), asc(schema.brandKits.name)] }));
}

/** The project's kit when it still exists, else the workspace default, else any kit, else the platform look. */
export async function loadBrand(ctx: Ctx, kitId?: string | null) {
  if (kitId) {
    const chosen = await withOrgContext(ctx, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ctx.organizationId), eq(schema.brandKits.id, kitId)) }));
    if (chosen) return brandFromRow(chosen);
  }
  const kits = await listBrandKits(ctx);
  return brandFromRow(kits[0]);
}

const candidate = (k: BrandKitRow): KitCandidate => ({ id: k.id, name: k.name, description: k.description, keywords: k.matchKeywords, isDefault: k.isDefault });

/** Below this the matcher's answer is treated as "no kit clearly fits". */
const MIN_CONFIDENCE = 0.55;

/**
 * Kit for an article: Haiku reads the kits' names / descriptions / keywords
 * against the article; keyword scoring takes over when the model is
 * unavailable. Only kits with `auto_match` compete against the default; when
 * there is none, nothing is to choose and no call is made. `id: null` = default kit.
 */
export async function chooseBrandKit(ctx: Ctx & { projectId: string }, article: { title: string | null; text: string }): Promise<{ id: string | null; name: string | null; reason: string; method: "single" | "model" | "keywords" | "default" }> {
  const kits = (await listBrandKits(ctx)).filter((k) => k.autoMatch || k.isDefault);
  if (!kits.some((k) => k.autoMatch && !k.isDefault)) return { id: null, name: null, reason: "chỉ có một bộ nhận diện", method: "single" };
  const candidates = kits.map(candidate);
  const named = (id: string, reason: string, method: "model" | "keywords") => ({ id, name: kits.find((k) => k.id === id)?.name ?? null, reason, method });
  try {
    const pick = await pickBrandKit({ ...article, kits: candidates }, ctx);
    if (pick.kitId && pick.confidence >= MIN_CONFIDENCE && kits.some((k) => k.id === pick.kitId)) return named(pick.kitId, pick.reason.slice(0, 300), "model");
    return { id: null, name: null, reason: pick.reason.slice(0, 300) || "không bộ nào khớp rõ", method: "default" };
  } catch (e) {
    console.warn("[brand] kit matcher failed, using keywords", e);
    const byKeyword = pickKitByKeywords(candidates, article);
    return byKeyword ? named(byKeyword.id, byKeyword.reason, "keywords") : { id: null, name: null, reason: "không bộ nào khớp rõ", method: "default" };
  }
}
