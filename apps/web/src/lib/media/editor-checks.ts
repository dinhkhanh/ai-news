/**
 * Pre-export checks of an editor document (the editor's "Kiểm tra" panel, the Deliver view and ⌘K).
 * Pure: every check reads the document plus what the editor already holds (swap options with their
 * faces, faithfulness verdicts, the mixed-audio state) and returns issues; an issue may name a fix the
 * editor knows how to apply. The plugin layer (`components/editor/plugins/checks-core.ts`) wraps each
 * check as a `checks` contribution, so a workspace can switch one off like any other plugin.
 */
import type { TextLayoutInput } from "@ai-news/video/schema";
import { PLATFORM_SPEC, type Platform } from "@/lib/publish/platforms";
import { sceneShots, sceneVoiceMs, setShot, shotsMissing, visualKey, type EditorDoc, type EditorScene, type EditorVisual } from "./editor";
import { frameStill, overlayZones, FRAMING_ISSUE_LABEL, type FrameFaces } from "./framing";
import { docShots, MAX_THIRD_PARTY_RUN_SEC, MAX_THIRD_PARTY_VIDEO_SHARE, originalityReport } from "./originality";

export type IssueSeverity = "fix" | "should" | "info";

/** What the editor does when the user clicks an issue's button. */
export type IssueFix =
  | { kind: "add-shots"; sceneId: string; label: string }
  | { kind: "replace-shot"; sceneId: string; shot: number; label: string }
  | { kind: "auto-frame"; sceneId: string; shot: number; label: string }
  | { kind: "rewrite"; sceneId: string; label: string }
  | { kind: "open"; sceneId: string; tab: "content" | "shots" | "captions" | "motion"; shot?: number; label: string };

export type Issue = {
  /** Stable per document state: check id + where. */
  id: string;
  checkId: string;
  severity: IssueSeverity;
  sceneId: string | null;
  title: string;
  detail: string | null;
  fix: IssueFix | null;
};

/** The swap option fields the checks need (structurally a `VisualOption`). */
export type CheckOption = {
  assetId: string;
  key: string;
  kind: "video" | "image";
  durationSec: number | null;
  credit: string | null;
  thumbnailUrl: string | null;
  provider: string;
  sceneId: string | null;
  frame: FrameFaces | null;
};

export type CheckInput = {
  doc: EditorDoc;
  options: CheckOption[];
  verdicts: Record<string, { verdict: "supported" | "partial" | "unsupported"; note: string | null; evidence: string | null }> | null;
  /** The stored mix matches the document's audio layout. */
  mixUsable: boolean;
  /** Total length of the built timeline. */
  durationSec: number;
  /** Platforms of the workspace's channels (duration limits); empty = every platform. */
  platforms: Platform[];
  /** A logo is drawn (kit or channel): part of the face guard's zones. */
  hasLogo: boolean;
};

export type Check = { id: string; label: string; run: (input: CheckInput) => Issue[] };

const SEVERITY_ORDER: Record<IssueSeverity, number> = { fix: 0, should: 1, info: 2 };
const fmt = (sec: number) => `${sec.toFixed(1).replace(".", ",")} s`;
const shotName = (sceneId: string, shot: number) => (shot === 0 ? sceneId : `${sceneId} #${shot + 1}`);

/** R2 key → where it is used ("s3", "s3 #2"), in document order. */
export function usedKeys(doc: Pick<EditorDoc, "scenes">): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of doc.scenes)
    sceneShots(s).forEach((v, i) => {
      const k = visualKey(v);
      if (k) out[k] = [...(out[k] ?? []), shotName(s.id, i)];
    });
  return out;
}

/** A swap option as a shot (the same defaults the inspector uses). */
export function visualFromOption(o: CheckOption): EditorVisual {
  return o.kind === "video"
    ? { kind: "video", key: o.key, clipDurationSec: o.durationSec ?? 5, trimStartSec: 0, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl }
    : { kind: "image", key: o.key, kenBurns: true, focus: null, sketch: null, credit: o.credit, assetId: o.assetId, thumbnailUrl: o.thumbnailUrl };
}

/**
 * Options not used anywhere in the document, best first for `sceneId`: the ones fetched for that scene, then the rest.
 * AI stills come last (sourcing priority, `visual-plan.ts`).
 */
export function unusedOptions(doc: Pick<EditorDoc, "scenes">, options: CheckOption[], sceneId: string): CheckOption[] {
  const used = usedKeys(doc);
  const rank = (o: CheckOption) => (o.sceneId === sceneId ? 0 : 2) + (o.provider === "gemini_image" ? 1 : 0);
  return options.filter((o) => !used[o.key]).sort((a, b) => rank(a) - rank(b));
}

/** Fill a scene's missing shots (≤ 5 s cadence) with unused options; returns the scene unchanged when none is left. */
export function fillMissingShots(doc: EditorDoc, options: CheckOption[], sceneId: string): EditorScene | null {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  const need = shotsMissing(scene);
  const picks = unusedOptions(doc, options, sceneId).slice(0, need);
  if (!picks.length) return null;
  return { ...scene, shots: [...scene.shots, ...picks.map(visualFromOption)].slice(0, 12) };
}

/** Replace one shot with the best unused option (a sketch look stays on the shot). */
export function replaceWithUnused(doc: EditorDoc, options: CheckOption[], sceneId: string, shot: number): EditorScene | null {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;
  const pick = unusedOptions(doc, options, sceneId)[0];
  if (!pick) return null;
  const current = sceneShots(scene)[shot];
  const next = visualFromOption(pick);
  return setShot(scene, shot, next.kind === "image" && current?.kind === "image" && current.sketch ? { ...next, sketch: current.sketch } : next);
}

/** The face guard's zones for a scene (same inputs the inspector uses). */
export function sceneZones(doc: Pick<EditorDoc, "brand">, scene: EditorScene, hasLogo: boolean) {
  const b = doc.brand as { caption: TextLayoutInput["caption"]; headline?: TextLayoutInput["headline"]; showSource: boolean };
  return overlayZones({ kind: scene.kind, headline: scene.onScreenText, hasCaptions: Boolean(scene.voice), caption: b.caption, headlineStyle: b.headline, showSource: b.showSource, hasLogo });
}

/** Crop the still at (scene, shot) by its faces; null when it is not an analysed still. */
export function autoFrameShot(doc: EditorDoc, options: CheckOption[], sceneId: string, shot: number, hasLogo: boolean): EditorScene | null {
  const scene = doc.scenes.find((s) => s.id === sceneId);
  const v = scene ? sceneShots(scene)[shot] : null;
  if (!scene || !v || v.kind !== "image") return null;
  const frame = options.find((o) => o.key === v.key)?.frame ?? null;
  if (!frame) return null;
  const f = frameStill(frame, sceneZones(doc, scene, hasLogo));
  return setShot(scene, shot, { ...v, focus: f.focus, kenBurns: f.focus ? v.kenBurns && f.kenBurns : v.kenBurns });
}

/* ------------------------------------------------------------------ checks */

const shotHold: Check = {
  id: "checks.shot-hold",
  label: "Nhịp hình ≤ 5 s",
  run: ({ doc }) =>
    doc.scenes.flatMap((s) => {
      const missing = shotsMissing(s);
      if (!missing) return [];
      const per = sceneVoiceMs(s) / 1000 / sceneShots(s).length;
      return [{ id: `shot-hold:${s.id}`, checkId: "checks.shot-hold", severity: "should" as const, sceneId: s.id, title: `${s.id} giữ mỗi hình ${fmt(per)}`, detail: `Thêm ${missing} hình để đổi hình sau mỗi ≤ 5 s.`, fix: { kind: "add-shots" as const, sceneId: s.id, label: `Tự thêm ${missing} hình` } }];
    }),
};

const repeated: Check = {
  id: "checks.repeated-picture",
  label: "Hình không lặp",
  run: ({ doc }) => {
    const out: Issue[] = [];
    const used = usedKeys(doc);
    for (const s of doc.scenes)
      sceneShots(s).forEach((v, i) => {
        const k = visualKey(v);
        if (!k) return;
        const at = used[k] ?? [];
        // Flag every use after the first.
        const here = shotName(s.id, i);
        if (at.length > 1 && at[0] !== here)
          out.push({ id: `repeat:${here}`, checkId: "checks.repeated-picture", severity: "should", sceneId: s.id, title: `Hình ở ${here} lặp lại ${at[0]}`, detail: "Mỗi hình chỉ nên xuất hiện một lần trong video.", fix: { kind: "replace-shot", sceneId: s.id, shot: i, label: `Thay ở ${here}` } });
      });
    return out;
  },
};

const solidShots: Check = {
  id: "checks.solid-shot",
  label: "Không còn nền màu tạm",
  run: ({ doc }) =>
    doc.scenes.flatMap((s) => {
      const all = sceneShots(s);
      if (all.length === 1 && all[0].kind === "solid" && s.kind === "cta") return []; // a closing card on the brand colour is a choice
      return all.flatMap((v, i) =>
        v.kind === "solid" ? [{ id: `solid:${shotName(s.id, i)}`, checkId: "checks.solid-shot", severity: "should" as const, sceneId: s.id, title: `${shotName(s.id, i)} đang là nền màu`, detail: "Chọn một hình hoặc clip cho cảnh quay này.", fix: { kind: "replace-shot" as const, sceneId: s.id, shot: i, label: "Lấy hình chưa dùng" } }] : [],
      );
    }),
};

const VERDICT_LABEL = { supported: "có căn cứ", partial: "chỉ có căn cứ một phần", unsupported: "không có căn cứ" } as const;

const faithfulness: Check = {
  id: "checks.faithfulness",
  label: "Kiểm chứng với bài gốc",
  run: ({ doc, verdicts }) => {
    if (!verdicts) return [{ id: "faith:none", checkId: "checks.faithfulness", severity: "info", sceneId: null, title: "Kịch bản chưa được kiểm chứng", detail: "Người duyệt sẽ phải xác nhận bỏ qua kiểm chứng.", fix: null }];
    return doc.scenes.flatMap((s): Issue[] => {
      const v = verdicts[s.id];
      if (!v) return s.kind === "body" ? [{ id: `faith:${s.id}`, checkId: "checks.faithfulness", severity: "info" as const, sceneId: s.id, title: `${s.id} chưa được kiểm chứng`, detail: null, fix: null }] : [];
      if (v.verdict === "supported") return [];
      return [{ id: `faith:${s.id}`, checkId: "checks.faithfulness", severity: v.verdict === "unsupported" ? ("fix" as const) : ("should" as const), sceneId: s.id, title: `${s.id} ${VERDICT_LABEL[v.verdict]}`, detail: v.note, fix: { kind: "rewrite" as const, sceneId: s.id, label: "Viết lại theo bài gốc" } }];
    });
  },
};

const faces: Check = {
  id: "checks.faces",
  label: "Khuôn mặt không bị cắt / che",
  run: ({ doc, options, hasLogo }) => {
    const out: Issue[] = [];
    for (const s of doc.scenes) {
      const zones = sceneZones(doc, s, hasLogo);
      sceneShots(s).forEach((v, i) => {
        if (v.kind !== "image") return;
        const frame = options.find((o) => o.key === v.key)?.frame ?? null;
        if (!frame) return;
        const f = frameStill(frame, zones);
        const here = shotName(s.id, i);
        if (!f.ok) out.push({ id: `faces:${here}`, checkId: "checks.faces", severity: "should", sceneId: s.id, title: `${here}: ${f.issues.map((x) => FRAMING_ISSUE_LABEL[x]).join(", ")}`, detail: "Khung 9:16 không giữ trọn khuôn mặt; đổi ảnh khác hoặc rút gọn chữ trên màn hình.", fix: { kind: "open", sceneId: s.id, tab: "shots", shot: i, label: "Đổi ảnh" } });
        else if (f.faces && JSON.stringify(f.focus) !== JSON.stringify(v.focus))
          out.push({ id: `faces:${here}`, checkId: "checks.faces", severity: "should", sceneId: s.id, title: `${here} chưa căn theo khuôn mặt`, detail: `${f.faces} khuôn mặt; khung hiện tại có thể cắt hoặc để chữ che mặt.`, fix: { kind: "auto-frame", sceneId: s.id, shot: i, label: "Căn khung tự động" } });
      });
    }
    return out;
  },
};

const duration: Check = {
  id: "checks.duration",
  label: "Độ dài hợp nền tảng",
  run: ({ durationSec, platforms }) => {
    const list = (platforms.length ? [...new Set(platforms)] : (Object.keys(PLATFORM_SPEC) as Platform[])).filter((p) => PLATFORM_SPEC[p].maxDurationSec > 0 && durationSec > PLATFORM_SPEC[p].maxDurationSec);
    if (!list.length) return [];
    return [{ id: "duration", checkId: "checks.duration", severity: "fix", sceneId: null, title: `Video dài ${fmt(durationSec)}`, detail: `Quá giới hạn của ${list.map((p) => `${PLATFORM_SPEC[p].label} (${PLATFORM_SPEC[p].maxDurationSec} s)`).join(", ")}. Bỏ bớt cảnh hoặc rút gọn lời.`, fix: null }];
  },
};

const hookText: Check = {
  id: "checks.hook-text",
  label: "Cảnh mở đầu có chữ",
  run: ({ doc }) => {
    const hook = doc.scenes[0];
    if (!hook || hook.onScreenText.trim()) return [];
    return [{ id: `hook-text:${hook.id}`, checkId: "checks.hook-text", severity: "should", sceneId: hook.id, title: `${hook.id} mở đầu không có chữ`, detail: "Người xem lướt nhanh: một dòng chữ ở cảnh đầu giữ họ lại.", fix: { kind: "open", sceneId: hook.id, tab: "content", label: "Viết chữ" } }];
  },
};

const audio: Check = {
  id: "checks.audio",
  label: "Âm thanh",
  run: ({ doc, mixUsable }) => [
    ...(mixUsable ? [] : [{ id: "audio:mix", checkId: "checks.audio", severity: "info" as const, sceneId: null, title: "Lời + nhạc chưa trộn", detail: "Tự trộn lại khi lưu (vài giây); bản xem trước phát từng lời riêng.", fix: null }]),
    ...(doc.music ? [] : [{ id: "audio:music", checkId: "checks.audio", severity: "info" as const, sceneId: null, title: "Không có nhạc nền", detail: null, fix: null }]),
  ],
};

/**
 * Meta's original content rules (`originality.ts`): third-party video footage at most half of the running time and
 * never more than 10 s in a row. A shot's source comes from its option's provider; a key with no option is not counted.
 */
const originality: Check = {
  id: "checks.originality",
  label: "Nội dung nguyên bản (Meta)",
  run: ({ doc, options }) => {
    const providers = new Map(options.map((o) => [o.key, o.provider]));
    const shots = docShots(doc, (k) => providers.get(k));
    const r = originalityReport(shots);
    const out: Issue[] = [];
    if (r.share > MAX_THIRD_PARTY_VIDEO_SHARE) {
      const first = shots.find((s) => s.source === "third_party_video");
      out.push({
        id: "originality:share",
        checkId: "checks.originality",
        severity: "should",
        sceneId: first?.sceneId ?? null,
        title: `${Math.round(r.share * 100)} % thời lượng là video của người khác`,
        detail: `Facebook / Instagram hạ phân phối và tắt kiếm tiền với video chủ yếu là cảnh quay lấy lại, kể cả khi có lời bình. Giữ dưới ${Math.round(MAX_THIRD_PARTY_VIDEO_SHARE * 100)} %: thay bớt clip bằng ảnh, đồ hoạ chuyển động hoặc stock.`,
        fix: first ? { kind: "open", sceneId: first.sceneId, tab: "shots", shot: first.shot, label: "Đổi clip" } : null,
      });
    }
    for (const run of r.longRuns)
      out.push({
        id: `originality:run:${shotName(run.from.sceneId, run.from.shot)}`,
        checkId: "checks.originality",
        severity: "should",
        sceneId: run.to.sceneId,
        title: `${fmt(run.sec)} liền video của người khác (${shotName(run.from.sceneId, run.from.shot)} → ${shotName(run.to.sceneId, run.to.shot)})`,
        detail: `Xen ảnh, đồ hoạ hoặc stock vào giữa, tối đa ${MAX_THIRD_PARTY_RUN_SEC} s liền: Meta coi một chuỗi dài cảnh quay lấy lại là nội dung không nguyên bản.`,
        fix: { kind: "open", sceneId: run.to.sceneId, tab: "shots", shot: run.to.shot, label: "Đổi cảnh quay" },
      });
    return out;
  },
};

/** Every built-in check, in the order the panel lists them. */
export const BUILTIN_CHECKS: Check[] = [faithfulness, duration, shotHold, solidShots, repeated, faces, originality, hookText, audio];

/** Run checks and sort the issues: fix → should → info, then document order. */
export function runChecks(checks: Check[], input: CheckInput): Issue[] {
  const order = new Map(input.doc.scenes.map((s, i) => [s.id, i]));
  return checks
    .flatMap((c) => {
      try {
        return c.run(input);
      } catch {
        return [];
      }
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (order.get(a.sceneId ?? "") ?? -1) - (order.get(b.sceneId ?? "") ?? -1));
}
