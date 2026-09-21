"use server";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne } from "drizzle-orm";
import { schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { run, str, type ActionState } from "@/lib/admin";
import { PRONUNCIATION_MAX, validPronunciation } from "@/lib/media/pronounce";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * The shared pronunciation dictionary (/app/voices/pronunciations): rows with `organization_id` null, which every
 * workspace's voice-overs use (`loadPronunciations`). Anyone who can edit projects maintains it, so a word fixed once
 * is read right everywhere. Written through the service context because the workspace policy only lets a workspace
 * write its own rows; the author is kept in `created_by` and every change is logged.
 */

const lang = (v: string) => (v === "en" ? "en" : "vi") as "vi" | "en";

export async function savePronunciation(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const id = str(fd, "id");
    const language = lang(str(fd, "language"));
    const term = str(fd, "term").slice(0, PRONUNCIATION_MAX);
    const replacement = str(fd, "replacement").replace(/\s+/g, " ").slice(0, PRONUNCIATION_MAX);
    const problem = validPronunciation(term, replacement);
    if (problem) throw new Error(problem);
    const saved = await withServiceContext(async (tx) => {
      const clash = await tx.query.pronunciations.findFirst({
        where: and(isNull(schema.pronunciations.organizationId), eq(schema.pronunciations.language, language), eq(schema.pronunciations.term, term), ...(id ? [ne(schema.pronunciations.id, id)] : [])),
      });
      if (clash) throw new Error(`“${term}” is already in the dictionary (read as “${clash.replacement}”); edit that entry instead`);
      if (id) {
        const [row] = await tx
          .update(schema.pronunciations)
          .set({ language, term, replacement })
          .where(and(eq(schema.pronunciations.id, id), isNull(schema.pronunciations.organizationId)))
          .returning({ id: schema.pronunciations.id });
        if (!row) throw new Error("That entry no longer exists");
        return row;
      }
      const [row] = await tx.insert(schema.pronunciations).values({ organizationId: null, language, term, replacement, createdBy: ws.userId }).returning({ id: schema.pronunciations.id });
      return row;
    }, ws.userId);
    await log(id ? "pronunciation.updated" : "pronunciation.created", { pronunciationId: saved.id, language, term, replacement });
    revalidatePath("/app/voices/pronunciations");
    return `“${term}” will be read as “${replacement}” in new voice-overs`;
  });
}

export async function deletePronunciation(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const id = str(fd, "id");
    const [row] = await withServiceContext(
      (tx) =>
        tx
          .delete(schema.pronunciations)
          .where(and(eq(schema.pronunciations.id, id), isNull(schema.pronunciations.organizationId)))
          .returning({ term: schema.pronunciations.term, replacement: schema.pronunciations.replacement, language: schema.pronunciations.language }),
      ws.userId,
    );
    if (!row) throw new Error("That entry no longer exists");
    await log("pronunciation.deleted", { pronunciationId: id, ...row });
    revalidatePath("/app/voices/pronunciations");
    return `“${row.term}” removed from the dictionary`;
  });
}
