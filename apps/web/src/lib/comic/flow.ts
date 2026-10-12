import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { ComicDoc } from "@ai-news/video/comic";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { presignGet } from "@/lib/r2";
import { docImageKeys, linkCast } from "./doc";
import type { AdaptInput } from "./prompts";
import { loadComic, optionsOf, styleOf, updateDoc, type ComicRow, type Ctx } from "./service";

/** Steps shared by the server actions and the jobs (docs/COMIC.md §2). */

/** The adaptation request for a comic: its story and options, and the library characters the member cast. */
export async function adaptInputFor(ctx: Ctx, comic: ComicRow): Promise<AdaptInput> {
  const opts = optionsOf(comic);
  const ids = opts.castIds ?? [];
  const chars = ids.length
    ? await withOrgContext(ctx, (tx) => tx.select().from(schema.comicCharacters).where(and(inArray(schema.comicCharacters.id, ids), eq(schema.comicCharacters.organizationId, ctx.organizationId))))
    : [];
  const style = styleOf(comic);
  return {
    story: comic.story,
    language: comic.language,
    pages: comic.pageTarget,
    audience: (comic.audience as AdaptInput["audience"]) ?? "general",
    dialogue: opts.dialogue ?? "medium",
    free: Boolean(opts.free),
    readingDirection: comic.readingDirection === "rtl" ? "rtl" : "ltr",
    style: { name: style.name, storytellingNotes: style.storytellingNotes, colourMode: style.colourMode },
    cast: chars.map((c) => ({ id: c.id, name: c.name, role: c.role, visual: c.visual, personality: c.personality })),
    title: comic.title,
  };
}

/**
 * Approving the script: every character the adaptation proposed (`new:` refs) becomes a library character, so its
 * sheet is reusable and later comics can cast it. The comic moves on to `script_approved`.
 */
export async function approveScript(ctx: Ctx, comicId: string) {
  const loaded = await loadComic(ctx, comicId);
  if (!loaded?.version) throw new Error("Truyện chưa có kịch bản");
  const proposed = loaded.version.doc.cast.filter((c) => !c.characterId);
  const created = proposed.length
    ? await withOrgContext(ctx, (tx) =>
        tx
          .insert(schema.comicCharacters)
          .values(proposed.map((c) => ({ organizationId: ctx.organizationId, name: c.name, role: c.role, visual: c.visual, personality: c.personality, createdBy: ctx.userId })))
          .returning({ id: schema.comicCharacters.id }),
      )
    : [];
  const links = proposed.map((c, i) => ({ ref: c.ref, id: created[i].id }));
  await updateDoc(
    ctx,
    comicId,
    "edit",
    (doc) => ({ doc: links.reduce((d, l) => linkCast(d, l.ref, l.id), doc), changes: { approved: true, newCharacters: links.length } }),
    { state: "script_approved" },
  );
  return { newCharacters: links.length };
}

/** Presigned URLs for every picture of a document (3 h); with `variants`, the earlier drawings too (page editor). */
export async function presignDoc(doc: ComicDoc, opts: { expiresIn?: number; variants?: boolean } = {}) {
  const expiresIn = opts.expiresIn ?? 3 * 3600;
  const keys = docImageKeys(doc, { variants: opts.variants });
  const urls = await Promise.all(keys.map((k) => presignGet(k, expiresIn)));
  return Object.fromEntries(keys.map((k, i) => [k, urls[i]]));
}
