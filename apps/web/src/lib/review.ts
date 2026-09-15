import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Timeline } from "@ai-news/video/schema";
import { schema } from "@/db";
import { withOrgContext, type Tx } from "@/db/context";
import { logActivity } from "@/lib/activity";
import type { StoredFaithfulness } from "@/lib/llm/schemas";
import { audioSignature, buildFromDoc, describeChanges, docFromTimeline, docKeys, editorDocSchema, type EditorDoc } from "@/lib/media/editor";
import { mixDocAudio } from "@/lib/media/remix";
import type { Workspace } from "@/lib/workspace";

/** Publisher-level roles approve; editors draft (docs/PLAN.md §4.8). */
export function canApprove(ws: Pick<Workspace, "role" | "isAdmin">) {
  return ws.isAdmin || ["publisher", "admin", "owner"].includes(ws.role);
}

export type TimelineRow = typeof schema.timelines.$inferSelect;

/** Editor document + audio provenance of a stored version. */
export function docOfRow(row: TimelineRow): { doc: EditorDoc; mix: { mixKey: string; voiceKey: string | null; signature: string } | null } {
  const t = row.json as unknown as Timeline;
  const doc = docFromTimeline(t, row.buildJson);
  const b = row.buildJson as { mix?: { mixKey?: string; voiceKey?: string; signature?: string } };
  const mixKey = b.mix?.mixKey ?? t.audio.mixSrc;
  const mix = mixKey ? { mixKey, voiceKey: b.mix?.voiceKey ?? t.audio.voiceSrc ?? null, signature: b.mix?.signature ?? audioSignature(doc) } : null;
  return { doc, mix };
}

/**
 * Keys a document may reference: this project's media, org-wide deduped assets
 * (stock clips shared across projects), library items and brand files.
 * Anything else is rejected so a crafted save cannot read foreign objects.
 */
async function assertKeysAllowed(tx: Tx, ctx: { organizationId: string; projectId: string }, keys: string[]) {
  const foreign = keys.filter((k) => !k.startsWith(`media/${ctx.organizationId}/`) && !k.startsWith("library/") && !k.startsWith(`candidates/${ctx.organizationId}/`));
  if (foreign.length === 0) return;
  const rows = await tx.select({ r2Path: schema.assets.r2Path }).from(schema.assets).where(and(eq(schema.assets.organizationId, ctx.organizationId), inArray(schema.assets.r2Path, foreign)));
  const ok = new Set(rows.map((r) => r.r2Path));
  const bad = foreign.filter((k) => !ok.has(k));
  if (bad.length) throw new Error(`Tệp không thuộc workspace này: ${bad[0]}`);
}

export type SaveVersionInput = {
  ws: { userId: string; organizationId: string };
  projectId: string;
  doc: unknown;
  /** Version the editor loaded; a newer version on the server rejects the save (optimistic lock). */
  baseVersion: number;
  kind: "edited" | "regenerated";
  note?: string | null;
  /** Extra provenance merged into build_json (voice timing method, stock ranking…). */
  build?: Record<string, unknown>;
  /** Change lines to prepend (regeneration describes itself; edits are diffed). */
  changes?: string[];
};

/**
 * Store a new timeline version from an editor document (docs/PLAN.md §4.7
 * "Each save = new version"): validates the document and its keys, re-mixes
 * the audio when the layout changed, rebuilds timeline JSON v1, links the
 * parent version and clears any approval so the publisher reviews again.
 */
export async function saveTimelineVersion(input: SaveVersionInput) {
  const parsed = editorDocSchema.safeParse(input.doc);
  if (!parsed.success) throw new Error(`Tài liệu không hợp lệ: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const doc = parsed.data;
  const ctx = { userId: input.ws.userId, organizationId: input.ws.organizationId, projectId: input.projectId };

  const base = await withOrgContext(input.ws, async (tx) => {
    const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId) });
    if (!project) throw new Error("Project not found in this workspace");
    const latest = await tx.query.timelines.findFirst({ where: eq(schema.timelines.projectId, input.projectId), orderBy: desc(schema.timelines.version) });
    if (!latest) throw new Error("Dựng timeline trước khi chỉnh sửa");
    if (latest.version !== input.baseVersion) throw new Error(`Đã có phiên bản v${latest.version} mới hơn (bạn đang sửa v${input.baseVersion}). Tải lại trang rồi sửa tiếp.`);
    await assertKeysAllowed(tx, ctx, docKeys(doc));
    return { project, latest };
  });

  const prev = docOfRow(base.latest);
  // A regeneration describes itself; drop the diff lines that merely restate it (new voice file / new clip on that scene).
  const explicit = input.changes ?? [];
  const diff = describeChanges(prev.doc, doc).filter((line) => !explicit.some((c) => c.split(":")[0] === line.split(":")[0] && /giọng đọc mới|đổi clip|Đổi nhạc/.test(line)));
  const changes = [...explicit, ...diff];
  if (changes.length === 0 && input.kind === "edited") throw new Error("Không có thay đổi nào để lưu");

  // Reuse the previous mix when the audio layout is untouched; otherwise mix again.
  const signature = audioSignature(doc);
  const mix = prev.mix && prev.mix.signature === signature ? { ...prev.mix, integratedLufs: null, reused: true } : { ...(await mixDocAudio(doc, ctx)), reused: false };
  const { timeline, durationSec } = buildFromDoc(doc, { mixKey: mix.mixKey, voiceKey: mix.voiceKey });

  const row = await withOrgContext(input.ws, async (tx) => {
    const buildJson = {
      ...(base.latest.buildJson as Record<string, unknown>),
      ...(input.build ?? {}),
      doc,
      mix: { mixKey: mix.mixKey, voiceKey: mix.voiceKey, signature, integratedLufs: mix.integratedLufs, reused: mix.reused },
      editedFrom: base.latest.version,
    };
    const [t] = await tx
      .insert(schema.timelines)
      .values({
        organizationId: input.ws.organizationId,
        projectId: input.projectId,
        version: base.latest.version + 1,
        json: timeline as unknown as Record<string, unknown>,
        scriptId: base.latest.scriptId,
        durationSec: durationSec.toFixed(2),
        buildJson,
        note: input.note ?? null,
        parentId: base.latest.id,
        kind: input.kind,
        changes,
        createdBy: input.ws.userId,
      })
      .returning({ id: schema.timelines.id, version: schema.timelines.version });
    // Any new version invalidates the approval; the state returns to composed for a fresh review.
    const wasReviewed = ["in_review", "approved", "rendered"].includes(base.project.state);
    await tx
      .update(schema.projects)
      .set({ state: wasReviewed ? "composed" : base.project.state, approvedTimelineId: null, approvedBy: null, approvedAt: null, busyStep: null, lastError: null })
      .where(eq(schema.projects.id, input.projectId));
    return t;
  });
  await logActivity({
    actorId: input.ws.userId,
    organizationId: input.ws.organizationId,
    projectId: input.projectId,
    type: input.kind === "edited" ? "timeline.edited" : "timeline.regenerated",
    payload: { timelineId: row.id, version: row.version, parentVersion: base.latest.version, changes, durationSec, remixed: !mix.reused, mixCostUsd: mix.reused ? 0 : (mix as { costUsd?: number }).costUsd ?? 0 },
  });
  return { id: row.id, version: row.version, mixKey: mix.mixKey, voiceKey: mix.voiceKey, durationSec, changes, approvalCleared: Boolean(base.project.approvedTimelineId) };
}

/** Faithfulness verdicts for the script a timeline was built from (null when the check is missing). */
export function verdictsOfScript(script: { faithfulnessJson: Record<string, unknown> | null } | null | undefined) {
  const f = script?.faithfulnessJson && "scenes" in script.faithfulnessJson ? (script.faithfulnessJson as unknown as StoredFaithfulness) : null;
  if (!f) return null;
  return { verdicts: Object.fromEntries(f.scenes.map((s) => [s.sceneId, { verdict: s.verdict, note: s.note, evidence: s.evidence }])), counts: f.counts };
}

/** True when the script backing a timeline has scenes the faithfulness pass could not support (publisher override needed). */
export function needsFaithfulnessOverride(script: { faithfulnessJson: Record<string, unknown> | null } | null | undefined) {
  const v = verdictsOfScript(script);
  if (!v) return true; // no check at all → treat as unverified
  return v.counts.unsupported + v.counts.unchecked > 0;
}
