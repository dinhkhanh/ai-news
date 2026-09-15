import "server-only";
import { brandSchema, type Brand } from "@ai-news/video/schema";
import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";

/** Platform default brand kit (used until a workspace defines one at /app/brand). */
export const DEFAULT_BRAND: Brand = brandSchema.parse({ colours: {}, fonts: {}, caption: {} });

export type BrandKitRow = typeof schema.brandKits.$inferSelect;

/** Map a brand_kits row to the timeline's embedded brand (logo stays an R2 key here). */
export function brandFromRow(row: BrandKitRow | null | undefined): { brand: Brand; logoKey: string | null; id: string | null } {
  if (!row) return { brand: DEFAULT_BRAND, logoKey: null, id: null };
  const cs = row.captionStyle as Partial<Brand["caption"]>;
  const brand = brandSchema.parse({
    name: row.name,
    colours: { ...DEFAULT_BRAND.colours, ...row.colours },
    fonts: { ...DEFAULT_BRAND.fonts, ...row.fonts },
    caption: { ...DEFAULT_BRAND.caption, ...cs },
    logoSrc: row.logoPath,
    showSource: (row.lowerThird as { showSource?: boolean } | null)?.showSource ?? true,
    outroText: (row.lowerThird as { outroText?: string | null } | null)?.outroText ?? null,
  });
  return { brand, logoKey: row.logoPath, id: row.id };
}

export async function loadBrand(ctx: { userId: string; organizationId: string }) {
  const row = await withOrgContext(ctx, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ctx.organizationId), eq(schema.brandKits.isDefault, true)) }));
  const fallback = row ?? (await withOrgContext(ctx, (tx) => tx.query.brandKits.findFirst({ where: eq(schema.brandKits.organizationId, ctx.organizationId) })));
  return brandFromRow(fallback);
}
