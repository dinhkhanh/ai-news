"use server";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { PROMPT_PURPOSES, type PromptPurpose } from "@/lib/integrations";

function parsePurposeLang(fd: FormData) {
  const purpose = str(fd, "purpose") as PromptPurpose;
  const language = str(fd, "language") as "vi" | "en";
  if (!PROMPT_PURPOSES.includes(purpose)) throw new Error("Unknown purpose");
  if (language !== "vi" && language !== "en") throw new Error("Unknown language");
  return { purpose, language };
}

export async function createPromptVersion(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const { purpose, language } = parsePurposeLang(fd);
    const body = String(fd.get("body") ?? "").trim();
    if (body.length < 20) throw new Error("Template body is too short");
    const latest = await db.query.promptTemplates.findFirst({
      where: and(eq(schema.promptTemplates.purpose, purpose), eq(schema.promptTemplates.language, language)),
      orderBy: desc(schema.promptTemplates.version),
    });
    const version = (latest?.version ?? 0) + 1;
    const promote = fd.get("promote") === "on";
    await db.transaction(async (tx) => {
      if (promote) {
        await tx
          .update(schema.promptTemplates)
          .set({ promoted: false })
          .where(and(eq(schema.promptTemplates.purpose, purpose), eq(schema.promptTemplates.language, language)));
      }
      await tx.insert(schema.promptTemplates).values({
        purpose,
        language,
        version,
        body,
        model: str(fd, "model") || null,
        notes: str(fd, "notes") || null,
        promoted: promote,
        createdBy: session.user.id,
      });
    });
    await log("admin.prompt.version_created", { purpose, language, version, promoted: promote });
    revalidatePath("/admin/prompts");
    return `Saved ${purpose}/${language} v${version}${promote ? " and promoted" : ""}`;
  });
}

export async function promotePromptVersion(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const id = str(fd, "id");
    const row = await db.query.promptTemplates.findFirst({ where: eq(schema.promptTemplates.id, id) });
    if (!row) throw new Error("Template not found");
    await db.transaction(async (tx) => {
      await tx
        .update(schema.promptTemplates)
        .set({ promoted: false })
        .where(and(eq(schema.promptTemplates.purpose, row.purpose), eq(schema.promptTemplates.language, row.language)));
      await tx.update(schema.promptTemplates).set({ promoted: true }).where(eq(schema.promptTemplates.id, id));
    });
    await log("admin.prompt.promoted", { purpose: row.purpose, language: row.language, version: row.version });
    revalidatePath("/admin/prompts");
    return `Promoted ${row.purpose}/${row.language} v${row.version}`;
  });
}
