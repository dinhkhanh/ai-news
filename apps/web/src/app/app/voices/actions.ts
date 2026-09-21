"use server";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { run, str, type ActionState } from "@/lib/admin";
import { synthesizeSample, toPreset } from "@/lib/media/tts";
import { GEMINI_TTS_MODEL, isGeminiVoice, SAMPLE_TEXT, VOICE_PROMPT_MAX } from "@/lib/media/voices";
import { assertWorkspaceWriter } from "@/lib/workspace";

/**
 * Workspace voices (/app/voices). Anyone who can edit projects manages them: a voice is a shared workspace
 * setting like a project, not an admin one. Platform voices (organization_id null) can be used and heard, never changed.
 */

const lang = (v: string) => (v === "en" ? "en" : "vi") as "vi" | "en";

/** Create or update a Gemini-TTS voice: name, main language, voice, style prompt, optionally the workspace default. */
export async function saveVoice(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const id = str(fd, "id");
    const name = str(fd, "name").slice(0, 80);
    const language = lang(str(fd, "language"));
    const voice = str(fd, "voice");
    const prompt = String(fd.get("prompt") ?? "").replace(/\r\n?/g, "\n").trim();
    const isDefault = fd.get("isDefault") === "on";
    if (!name) throw new Error("Give the voice a name");
    if (!isGeminiVoice(voice)) throw new Error("Pick a voice from the list");
    if (prompt.length > VOICE_PROMPT_MAX) throw new Error(`The style prompt is limited to ${VOICE_PROMPT_MAX} characters`);
    const values = { name, language, voice, model: GEMINI_TTS_MODEL, prompt: prompt || null, rate: "1.00", pitch: "0", ssmlSupported: false, isDefault };
    const saved = await withOrgContext(ws, async (tx) => {
      // One default per workspace and language (partial unique index): clear the old one first.
      if (isDefault) await tx.update(schema.voicePresets).set({ isDefault: false }).where(and(eq(schema.voicePresets.organizationId, ws.organizationId), eq(schema.voicePresets.language, language), ...(id ? [ne(schema.voicePresets.id, id)] : [])));
      if (id) {
        const [row] = await tx
          .update(schema.voicePresets)
          .set(values)
          .where(and(eq(schema.voicePresets.id, id), eq(schema.voicePresets.organizationId, ws.organizationId)))
          .returning({ id: schema.voicePresets.id });
        if (!row) throw new Error("That voice no longer exists (or is a platform voice)");
        return row;
      }
      const [row] = await tx.insert(schema.voicePresets).values({ ...values, organizationId: ws.organizationId, createdBy: ws.userId }).returning({ id: schema.voicePresets.id });
      return row;
    });
    await log(id ? "voice.updated" : "voice.created", { voicePresetId: saved.id, name, language, voice, model: GEMINI_TTS_MODEL, promptChars: prompt.length, isDefault });
    revalidatePath("/app/voices");
    return id ? `Voice “${name}” saved` : `Voice “${name}” created`;
  });
}

/** Make a workspace voice the default of its language, or clear the workspace default (the platform default applies again). */
export async function setDefaultVoice(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const id = str(fd, "id");
    const on = str(fd, "on") === "1";
    const row = await withOrgContext(ws, async (tx) => {
      const v = await tx.query.voicePresets.findFirst({ where: and(eq(schema.voicePresets.id, id), eq(schema.voicePresets.organizationId, ws.organizationId)) });
      if (!v) throw new Error("Only a workspace voice can be the workspace default");
      await tx.update(schema.voicePresets).set({ isDefault: false }).where(and(eq(schema.voicePresets.organizationId, ws.organizationId), eq(schema.voicePresets.language, v.language)));
      if (on) await tx.update(schema.voicePresets).set({ isDefault: true }).where(eq(schema.voicePresets.id, id));
      return v;
    });
    await log("voice.default_set", { voicePresetId: id, name: row.name, language: row.language, on });
    revalidatePath("/app/voices");
    return on ? `“${row.name}” is now the default ${row.language === "vi" ? "Vietnamese" : "English"} voice` : "Workspace default cleared; the platform default applies";
  });
}

/** Delete a workspace voice. Projects that picked it fall back to the default (`on delete set null`); built videos keep their audio. */
export async function deleteVoice(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { ws, log } = await assertWorkspaceWriter();
    const id = str(fd, "id");
    const [row] = await withOrgContext(ws, (tx) =>
      tx.delete(schema.voicePresets).where(and(eq(schema.voicePresets.id, id), eq(schema.voicePresets.organizationId, ws.organizationId))).returning({ name: schema.voicePresets.name }),
    );
    if (!row) throw new Error("That voice no longer exists (or is a platform voice)");
    await log("voice.deleted", { voicePresetId: id, name: row.name });
    revalidatePath("/app/voices");
    return `Voice “${row.name}” deleted`;
  });
}

export type VoiceSample = { ok: true; audio: string; durationMs: number } | { ok: false; message: string };

/**
 * "Nghe thử": a short sample, either of a saved voice (`presetId`: platform or this workspace) or of the form's
 * unsaved values. Returns the WAV as a data URL (a few hundred KB) so nothing is stored.
 */
export async function previewVoice(input: { presetId?: string; voice?: string; prompt?: string; language: string; text?: string }): Promise<VoiceSample> {
  try {
    const { ws, log } = await assertWorkspaceWriter();
    const language = lang(input.language);
    let preset: Parameters<typeof synthesizeSample>[0]["preset"];
    if (input.presetId) {
      const row = await withOrgContext(ws, (tx) =>
        tx.query.voicePresets.findFirst({ where: and(eq(schema.voicePresets.id, input.presetId!), or(eq(schema.voicePresets.organizationId, ws.organizationId), isNull(schema.voicePresets.organizationId))) }),
      );
      if (!row) throw new Error("Voice not found");
      preset = toPreset(row, language);
    } else {
      if (!input.voice || !isGeminiVoice(input.voice)) throw new Error("Pick a voice from the list");
      const prompt = (input.prompt ?? "").trim();
      if (prompt.length > VOICE_PROMPT_MAX) throw new Error(`The style prompt is limited to ${VOICE_PROMPT_MAX} characters`);
      preset = { voice: input.voice, model: GEMINI_TTS_MODEL, prompt: prompt || null, rate: 1, pitch: 0, ssmlSupported: false };
    }
    const text = input.text?.trim() || SAMPLE_TEXT[language];
    const r = await synthesizeSample({ text, language, preset }, ws);
    await log("voice.previewed", { voicePresetId: input.presetId ?? null, voice: preset.voice, language, chars: text.length, costUsd: Math.round(r.costUsd * 1e5) / 1e5 });
    return { ok: true, audio: `data:audio/wav;base64,${Buffer.from(r.wav).toString("base64")}`, durationMs: r.durationMs };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}
