"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { deleteObject, putObject, r2Key } from "@/lib/r2";

/** Upload a licensed track to the shared library (docs/PLAN.md §4.5 "else library"). */
export async function uploadTrack(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose an audio file");
    if (file.size > 25 * 1024 * 1024) throw new Error("Track must be under 25 MB");
    if (!/^audio\/(mpeg|mp3|wav|x-wav|mp4|aac|ogg)$/.test(file.type)) throw new Error(`Unsupported audio type ${file.type}`);
    const title = str(fd, "title") || file.name.replace(/\.[^.]+$/, "");
    const licence = str(fd, "licence");
    if (!licence) throw new Error("Licence is required (e.g. 'Purchased: Epidemic Sound #1234')");
    const ext = file.name.split(".").pop()?.toLowerCase() || "mp3";
    const key = r2Key.library(`music/${crypto.randomUUID()}.${ext}`);
    await putObject(key, Buffer.from(await file.arrayBuffer()), file.type);
    const moodTags = str(fd, "moodTags").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const durationRaw = str(fd, "durationSec");
    await db.insert(schema.musicLibrary).values({ title, r2Path: key, moodTags, licence, licenceUrl: str(fd, "licenceUrl") || null, durationSec: durationRaw ? Number(durationRaw).toFixed(2) : null, uploadedBy: session.user.id });
    await log("admin.music.uploaded", { title, moodTags, sizeBytes: file.size });
    revalidatePath("/admin/music");
    return `Added "${title}"`;
  });
}

export async function deleteTrack(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const id = str(fd, "id");
    const row = await db.query.musicLibrary.findFirst({ where: eq(schema.musicLibrary.id, id) });
    if (!row) throw new Error("Track not found");
    await db.delete(schema.musicLibrary).where(eq(schema.musicLibrary.id, id));
    await deleteObject(row.r2Path).catch(() => {});
    await log("admin.music.deleted", { title: row.title });
    revalidatePath("/admin/music");
    return `Removed "${row.title}"`;
  });
}
