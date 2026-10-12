"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { DEFAULT_CROP, LETTERING_KINDS, PAGE_LAYOUTS, type Balloon, type ComicDoc, type LetteringKind, type PageLayout, type Panel, type Rect } from "@ai-news/video/comic";
import { ComicPageView } from "@ai-news/video/comic-view";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { findPanel } from "@/lib/comic/doc";
import { applyEditorOp, type EditorOp } from "@/lib/comic/editor-ops";
import { cn } from "@/lib/utils";
import { drawPanels } from "../actions";
import { addStyleSample, applyEdit, shortenPanel, type EditorResult } from "../editor-actions";
import { KIND_LABEL, LAYOUT_LABEL } from "../labels";

type Families = Partial<Record<ComicDoc["font"], string>>;
type Selection = { panelId: string; balloonId: string | null } | null;
type Drag = { mode: "move" | "resize" | "tail"; panelId: string; balloonId: string; pointerId: number; x0: number; y0: number; rect: Rect; tail: { x: number; y: number } | null; moved: boolean };

const TAILLESS: LetteringKind[] = ["caption", "sfx"];
const pct = (n: number, of: number) => `${(n / of) * 100}%`;
const newBalloonId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Sets a balloon's box and tail as they are dragged, without placing the others again (that happens on release). */
function patchBalloon(doc: ComicDoc, panelId: string, balloonId: string, patch: Partial<Pick<Balloon, "rect" | "tail">>): ComicDoc {
  return {
    ...doc,
    pages: doc.pages.map((p) => ({ ...p, panels: p.panels.map((k) => (k.id !== panelId ? k : { ...k, lettering: k.lettering.map((b) => (b.id === balloonId ? { ...b, ...patch } : b)) })) })),
  };
}

/**
 * The page editor of the "Trang" tab (docs/COMIC.md §2.6): the page as it will be exported, with a layer on top to
 * select a panel or a balloon, drag balloons, resize them and aim their tails; the inspector redraws a panel, picks
 * among its drawings, crops it, and edits, adds or deletes lines. Every change is applied here at once and saved as a
 * new version in the background, in order.
 */
export function PageEditor({
  comicId,
  versionId,
  doc: serverDoc,
  srcs,
  families,
  writer,
  busy,
  approved,
}: {
  comicId: string;
  versionId: string;
  doc: ComicDoc;
  srcs: Record<string, string>;
  families: Families;
  writer: boolean;
  busy: boolean;
  approved: boolean;
}) {
  const router = useRouter();
  const [doc, setDoc] = useState(serverDoc);
  const [pending, setPending] = useState(0);
  const [seen, setSeen] = useState(versionId);
  // A newer version from the server (a panel drawn, another tab) replaces this copy once nothing is being saved.
  if (seen !== versionId && pending === 0) {
    setSeen(versionId);
    setDoc(serverDoc);
  }
  const [pageIdx, setPageIdx] = useState(0);
  const [sel, setSel] = useState<Selection>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const page = doc.pages[Math.min(pageIdx, doc.pages.length - 1)];
  const hit = sel ? findPanel(doc, sel.panelId) : null;
  const panel = hit?.panel ?? null;
  const balloon = panel && sel?.balloonId ? (panel.lettering.find((b) => b.id === sel.balloonId) ?? null) : null;
  const canEdit = writer;

  const save = (op: EditorOp) => {
    setPending((n) => n + 1);
    chain.current = chain.current.then(async () => {
      let res: EditorResult;
      try {
        res = await applyEdit({ comicId, op });
      } catch (e) {
        res = { ok: false, message: (e as Error).message };
      }
      if (!res.ok) toast.error(res.message);
      setPending((n) => {
        if (n === 1 || !res.ok) queueMicrotask(() => router.refresh());
        return n - 1;
      });
    });
  };

  /**
   * Applies an operation here at once and saves it in order. With `key`, the save waits for a pause (sliders, arrow
   * keys): those operations carry absolute values, so only the last one of a burst needs to reach the server.
   */
  const send = (op: EditorOp, key?: string) => {
    if (!canEdit) return;
    setDoc((d) => applyEditorOp(d, op));
    if (!key) return save(op);
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => save(op), 500);
  };

  const call = async (fn: () => Promise<EditorResult>) => {
    setPending((n) => n + 1);
    try {
      const res = await fn();
      (res.ok ? toast.success : toast.error)(res.message ?? "Đã lưu");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending((n) => n - 1);
      router.refresh();
    }
  };

  const toPage = (clientX: number, clientY: number) => {
    const box = overlay.current!.getBoundingClientRect();
    const s = doc.format.width / box.width;
    return { x: (clientX - box.left) * s, y: (clientY - box.top) * s };
  };

  const startDrag = (e: ReactPointerEvent, mode: Drag["mode"], k: Panel, b: Balloon) => {
    e.stopPropagation();
    setSel({ panelId: k.id, balloonId: b.id });
    if (!canEdit || !b.rect) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPage(e.clientX, e.clientY);
    drag.current = { mode, panelId: k.id, balloonId: b.id, pointerId: e.pointerId, x0: p.x, y0: p.y, rect: b.rect, tail: b.tail, moved: false };
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = toPage(e.clientX, e.clientY);
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const patch =
      d.mode === "move"
        ? { rect: { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy } }
        : d.mode === "resize"
          ? { rect: { ...d.rect, w: Math.max(40, d.rect.w + dx), h: Math.max(30, d.rect.h + dy) } }
          : { tail: { x: p.x, y: p.y } };
    setDoc((cur) => patchBalloon(cur, d.panelId, d.balloonId, patch));
  };

  const endDrag = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    const b = findPanel(doc, d.panelId)?.panel.lettering.find((x) => x.id === d.balloonId);
    if (b?.rect) send({ type: "place", panelId: d.panelId, balloonId: d.balloonId, rect: b.rect, tail: b.tail });
  };

  /** Arrow keys move the selected balloon (Shift: further); saved after a pause. */
  const onBalloonKey = (e: KeyboardEvent, k: Panel, b: Balloon) => {
    const step = doc.format.width * (e.shiftKey ? 0.025 : 0.005);
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta || !canEdit || !b.rect) return;
    e.preventDefault();
    send({ type: "place", panelId: k.id, balloonId: b.id, rect: { ...b.rect, x: b.rect.x + delta[0], y: b.rect.y + delta[1] }, tail: b.tail }, `move-${b.id}`);
  };

  const W = doc.format.width;
  const H = page?.height ?? doc.format.height;

  if (!page) return <p className="text-sm text-muted-foreground">Truyện chưa có trang nào.</p>;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav aria-label="Chọn trang" className="flex flex-wrap gap-1">
            {doc.pages.map((p, i) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={p.id === page.id ? "default" : "outline"}
                aria-current={p.id === page.id ? "page" : undefined}
                onClick={() => {
                  setPageIdx(i);
                  setSel(null);
                }}
              >
                {i + 1}
              </Button>
            ))}
          </nav>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {pending ? <span role="status">Đang lưu…</span> : null}
            {canEdit ? (
              <NativeSelect fieldSize="sm" aria-label="Bố cục trang" value={page.layout} onChange={(e) => send({ type: "layout", pageId: page.id, layout: e.target.value as PageLayout })}>
                {PAGE_LAYOUTS.map((l) => (
                  <option key={l} value={l}>
                    Bố cục: {LAYOUT_LABEL[l]}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </div>
        </div>

        <div className="mx-auto max-w-[640px]">
          <div className="relative overflow-hidden rounded-sm shadow-md ring-1 ring-border">
            <ComicPageView format={doc.format} font={doc.font} page={page} srcs={srcs} placeholders families={families} credit={pageIdx === doc.pages.length - 1 ? doc.credit : null} />
            <div ref={overlay} className="absolute inset-0 touch-none select-none" onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag} onClick={() => setSel(null)}>
              {page.panels.map((k, ki) => (
                <button
                  key={k.id}
                  type="button"
                  aria-label={`Khung ${ki + 1}`}
                  aria-pressed={sel?.panelId === k.id && !sel.balloonId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel({ panelId: k.id, balloonId: null });
                  }}
                  className={cn("absolute outline-none focus-visible:ring-3 focus-visible:ring-ring", sel?.panelId === k.id ? "ring-3 ring-primary/70" : "hover:ring-2 hover:ring-primary/30")}
                  style={{ left: pct(k.rect.x, W), top: pct(k.rect.y, H), width: pct(k.rect.w, W), height: pct(k.rect.h, H) }}
                />
              ))}
              {page.panels.flatMap((k) =>
                k.lettering
                  .filter((b) => b.rect)
                  .map((b) => {
                    const r = b.rect!;
                    const on = sel?.balloonId === b.id;
                    return (
                      <div key={b.id}>
                        <button
                          type="button"
                          aria-label={`Lời: ${b.text}`}
                          aria-pressed={on}
                          onPointerDown={(e) => startDrag(e, "move", k, b)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => onBalloonKey(e, k, b)}
                          onFocus={() => setSel({ panelId: k.id, balloonId: b.id })}
                          className={cn(
                            "absolute rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring",
                            canEdit ? "cursor-move" : "cursor-pointer",
                            on ? "ring-2 ring-sky-500" : b.overflow ? "ring-2 ring-amber-500" : "hover:ring-2 hover:ring-sky-400/60",
                          )}
                          style={{ left: pct(r.x, W), top: pct(r.y, H), width: pct(r.w, W), height: pct(r.h, H) }}
                        />
                        {on && canEdit ? (
                          <>
                            <span
                              role="presentation"
                              title="Kéo để đổi cỡ"
                              onPointerDown={(e) => startDrag(e, "resize", k, b)}
                              className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-sm border-2 border-white bg-sky-500 shadow"
                              style={{ left: pct(r.x + r.w, W), top: pct(r.y + r.h, H) }}
                            />
                            {b.tail && !TAILLESS.includes(b.kind) ? (
                              <span
                                role="presentation"
                                title="Kéo để chỉnh đuôi bóng"
                                onPointerDown={(e) => startDrag(e, "tail", k, b)}
                                className="absolute size-4 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white bg-sky-500 shadow"
                                style={{ left: pct(b.tail.x, W), top: pct(b.tail.y, H) }}
                              />
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    );
                  }),
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Bấm vào khung để vẽ lại, chọn bản vẽ, cắt khung hình; bấm vào lời thoại để sửa. {canEdit ? "Kéo bóng để dời, kéo góc để đổi cỡ, kéo chấm ở đuôi để chỉnh hướng; phím mũi tên dời từng chút (Shift: xa hơn)." : ""}
          </p>
        </div>
      </div>

      <aside aria-label="Thuộc tính" className="space-y-4 lg:sticky lg:top-4">
        {!panel ? (
          <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Chọn một khung hoặc một lời thoại trên trang.</div>
        ) : balloon ? (
          <BalloonInspector
            key={balloon.id}
            doc={doc}
            panel={panel}
            balloon={balloon}
            canEdit={canEdit}
            onBack={() => setSel({ panelId: panel.id, balloonId: null })}
            onSave={(edit) => send({ type: "balloon", panelId: panel.id, balloonId: balloon.id, edit })}
            onReset={() => send({ type: "resetBalloon", panelId: panel.id, balloonId: balloon.id })}
            onDelete={() => {
              send({ type: "deleteBalloon", panelId: panel.id, balloonId: balloon.id });
              setSel({ panelId: panel.id, balloonId: null });
            }}
          />
        ) : (
          <PanelInspector
            key={panel.id}
            comicId={comicId}
            doc={doc}
            panel={panel}
            index={{ page: doc.pages.findIndex((p) => p.id === hit!.page.id), panel: hit!.panelIndex }}
            srcs={srcs}
            canEdit={canEdit}
            busy={busy}
            approved={approved}
            onSelectBalloon={(id) => setSel({ panelId: panel.id, balloonId: id })}
            send={send}
            onShorten={() => call(() => shortenPanel({ comicId, panelId: panel.id }))}
            onSample={() => call(() => addStyleSample({ comicId, panelId: panel.id }))}
          />
        )}
      </aside>
    </div>
  );
}

function PanelInspector({
  comicId,
  doc,
  panel,
  index,
  srcs,
  canEdit,
  busy,
  approved,
  onSelectBalloon,
  send,
  onShorten,
  onSample,
}: {
  comicId: string;
  doc: ComicDoc;
  panel: Panel;
  index: { page: number; panel: number };
  srcs: Record<string, string>;
  canEdit: boolean;
  busy: boolean;
  approved: boolean;
  onSelectBalloon: (id: string) => void;
  send: (op: EditorOp, key?: string) => void;
  onShorten: () => void;
  onSample: () => void;
}) {
  const crop = panel.crop ?? DEFAULT_CROP;
  const [line, setLine] = useState<{ kind: LetteringKind; speaker: string; text: string }>({ kind: "speech", speaker: panel.script.characters[0]?.ref ?? "", text: "" });
  const overflow = panel.lettering.filter((b) => b.overflow).length;
  const setCrop = (patch: Partial<typeof crop>) => send({ type: "crop", panelId: panel.id, crop: { ...crop, ...patch } }, `crop-${panel.id}`);
  const nameOf = (ref: string | null) => (ref ? (doc.cast.find((c) => c.ref === ref)?.name ?? ref) : null);

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 text-sm">
      <div className="space-y-1">
        <h2 className="font-medium">
          Trang {index.page + 1} · Khung {index.panel + 1}
        </h2>
        <p className="text-xs text-muted-foreground">{panel.script.description}</p>
        {panel.error ? <p className="text-xs text-destructive">Lỗi lần vẽ trước: {panel.error}</p> : null}
      </div>

      {canEdit && approved ? (
        <ActionForm action={drawPanels} className="space-y-2">
          <input type="hidden" name="comicId" value={comicId} />
          <input type="hidden" name="panelId" value={panel.id} />
          <Label htmlFor={`instr-${panel.id}`} className="text-xs">
            {panel.image ? "Vẽ lại với chỉ dẫn" : "Vẽ khung này"}
          </Label>
          <Input id={`instr-${panel.id}`} name="instruction" placeholder="vd: bà đứng gần hơn, trời tối hơn" disabled={busy} />
          {panel.image ? (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" name="keep" className="size-4" disabled={busy} /> Giữ bố cục, chỉ sửa theo chỉ dẫn
            </label>
          ) : null}
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            {panel.image ? "Vẽ lại" : "Vẽ"}
          </Button>
          {busy ? <p className="text-xs text-muted-foreground">Đang chạy một bước khác; đợi xong rồi vẽ.</p> : null}
        </ActionForm>
      ) : null}

      {panel.variants.length ? (
        <section aria-labelledby={`var-${panel.id}`} className="space-y-2">
          <h3 id={`var-${panel.id}`} className="text-xs font-medium text-muted-foreground">
            Các bản vẽ · {panel.variants.length}
          </h3>
          <ul className="grid grid-cols-3 gap-2">
            {panel.variants.map((v, i) => {
              const current = panel.image?.id === v.id;
              return (
                <li key={v.id} className="relative">
                  <button
                    type="button"
                    aria-label={`Bản vẽ ${i + 1}${current ? " (đang dùng)" : ""}`}
                    aria-pressed={current}
                    disabled={!canEdit || current}
                    onClick={() => send({ type: "variant", panelId: panel.id, imageId: v.id })}
                    className={cn("block aspect-square w-full overflow-hidden rounded-md border bg-muted", current ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-primary/40")}
                  >
                    {srcs[v.key] ? (
                      // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                      <img src={srcs[v.key]} alt="" className="size-full object-cover" />
                    ) : null}
                  </button>
                  {canEdit && !current ? (
                    <button
                      type="button"
                      aria-label={`Bỏ bản vẽ ${i + 1}`}
                      onClick={() => send({ type: "removeVariant", panelId: panel.id, imageId: v.id })}
                      className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-xs shadow hover:bg-muted"
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {panel.image && canEdit ? (
        <section aria-labelledby={`crop-${panel.id}`} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 id={`crop-${panel.id}`} className="text-xs font-medium text-muted-foreground">
              Khung hình
            </h3>
            {panel.crop ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => send({ type: "crop", panelId: panel.id, crop: null })}>
                Đặt lại
              </Button>
            ) : null}
          </div>
          {(
            [
              ["zoom", "Phóng to", 1, 3, 0.05],
              ["x", "Ngang", 0, 1, 0.01],
              ["y", "Dọc", 0, 1, 0.01],
            ] as const
          ).map(([k, label, min, max, step]) => (
            <label key={k} className="grid grid-cols-[72px_1fr_40px] items-center gap-2 text-xs">
              {label}
              <input type="range" min={min} max={max} step={step} value={crop[k]} onChange={(e) => setCrop({ [k]: Number(e.target.value) })} className="w-full accent-primary" />
              <span className="text-right tabular-nums text-muted-foreground">{k === "zoom" ? `${crop.zoom.toFixed(2)}×` : `${Math.round(crop[k] * 100)}%`}</span>
            </label>
          ))}
        </section>
      ) : null}

      <section aria-labelledby={`lines-${panel.id}`} className="space-y-2">
        <h3 id={`lines-${panel.id}`} className="text-xs font-medium text-muted-foreground">
          Lời thoại · {panel.lettering.length}
        </h3>
        {overflow ? (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <p>{overflow} lời quá dài cho bóng của nó.</p>
            {canEdit ? (
              <Button type="button" size="sm" variant="outline" onClick={onShorten}>
                Rút gọn lời thoại (Claude)
              </Button>
            ) : null}
          </div>
        ) : null}
        <ul className="space-y-1">
          {panel.lettering.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => onSelectBalloon(b.id)} className="w-full rounded-md border px-2 py-1.5 text-left text-xs hover:bg-muted">
                <span className="text-muted-foreground">
                  {KIND_LABEL[b.kind]}
                  {nameOf(b.speaker) ? ` · ${nameOf(b.speaker)}` : ""}
                  {b.manual ? " · đặt tay" : ""}
                </span>
                <span className="block truncate">{b.text}</span>
              </button>
            </li>
          ))}
        </ul>
        {canEdit ? (
          <form
            className="space-y-2 border-t pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!line.text.trim()) return;
              send({ type: "addBalloon", panelId: panel.id, balloonId: newBalloonId(), kind: line.kind, speaker: TAILLESS.includes(line.kind) ? null : line.speaker || null, text: line.text.trim().slice(0, 300) });
              setLine((l) => ({ ...l, text: "" }));
            }}
          >
            <div className="flex gap-2">
              <NativeSelect fieldSize="sm" aria-label="Loại lời" value={line.kind} onChange={(e) => setLine((l) => ({ ...l, kind: e.target.value as LetteringKind }))} className="flex-1">
                {LETTERING_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
              {!TAILLESS.includes(line.kind) ? (
                <NativeSelect fieldSize="sm" aria-label="Người nói" value={line.speaker} onChange={(e) => setLine((l) => ({ ...l, speaker: e.target.value }))} className="flex-1">
                  <option value="">(không rõ)</option>
                  {doc.cast.map((c) => (
                    <option key={c.ref} value={c.ref}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Input aria-label="Lời mới" value={line.text} maxLength={300} onChange={(e) => setLine((l) => ({ ...l, text: e.target.value }))} placeholder="Thêm một lời…" className="min-w-0 flex-1" />
              <Button type="submit" size="sm" variant="outline" disabled={!line.text.trim()}>
                Thêm
              </Button>
            </div>
          </form>
        ) : null}
      </section>

      {canEdit && panel.image ? (
        <Button type="button" size="sm" variant="ghost" onClick={onSample} className="px-0 text-xs">
          Dùng hình này làm mẫu phong cách
        </Button>
      ) : null}
    </div>
  );
}

function BalloonInspector({
  doc,
  panel,
  balloon,
  canEdit,
  onBack,
  onSave,
  onReset,
  onDelete,
}: {
  doc: ComicDoc;
  panel: Panel;
  balloon: Balloon;
  canEdit: boolean;
  onBack: () => void;
  onSave: (edit: { text?: string; kind?: LetteringKind; speaker?: string | null; fontSize?: number }) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(balloon.text);
  const [kind, setKind] = useState<LetteringKind>(balloon.kind);
  const [speaker, setSpeaker] = useState(balloon.speaker ?? "");
  const [size, setSize] = useState(balloon.fontSize);
  const dirty = text.trim() !== balloon.text || kind !== balloon.kind || (speaker || null) !== balloon.speaker || size !== balloon.fontSize;
  const min = Math.round(doc.format.width * 0.012);
  const max = Math.round(doc.format.width * 0.08);
  const inPanel = new Set(panel.script.characters.map((c) => c.ref));

  return (
    <form
      className="space-y-3 rounded-xl border bg-card p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSave({
          ...(text.trim() !== balloon.text ? { text: text.trim() } : {}),
          ...(kind !== balloon.kind ? { kind } : {}),
          ...((speaker || null) !== balloon.speaker ? { speaker: speaker || null } : {}),
          ...(size !== balloon.fontSize ? { fontSize: size } : {}),
        });
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Lời thoại</h2>
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Khung
        </Button>
      </div>
      {balloon.overflow ? <p className="text-xs text-amber-700 dark:text-amber-400">Chữ không vừa bóng: rút gọn lời, giảm cỡ chữ hoặc kéo to bóng.</p> : null}
      <div className="space-y-1">
        <Label htmlFor={`text-${balloon.id}`} className="text-xs">
          Nội dung
        </Label>
        <Textarea id={`text-${balloon.id}`} value={text} maxLength={300} rows={3} onChange={(e) => setText(e.target.value)} disabled={!canEdit} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`kind-${balloon.id}`} className="text-xs">
            Loại
          </Label>
          <NativeSelect id={`kind-${balloon.id}`} fieldSize="sm" value={kind} onChange={(e) => setKind(e.target.value as LetteringKind)} disabled={!canEdit} className="w-full">
            {LETTERING_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {!TAILLESS.includes(kind) ? (
          <div className="space-y-1">
            <Label htmlFor={`spk-${balloon.id}`} className="text-xs">
              Người nói
            </Label>
            <NativeSelect id={`spk-${balloon.id}`} fieldSize="sm" value={speaker} onChange={(e) => setSpeaker(e.target.value)} disabled={!canEdit} className="w-full">
              <option value="">(không rõ)</option>
              {doc.cast.map((c) => (
                <option key={c.ref} value={c.ref}>
                  {c.name}
                  {inPanel.has(c.ref) ? "" : " (không có trong khung)"}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </div>
      <label className="grid grid-cols-[72px_1fr_40px] items-center gap-2 text-xs">
        Cỡ chữ
        <input type="range" min={min} max={max} step={1} value={size} onChange={(e) => setSize(Number(e.target.value))} disabled={!canEdit} className="w-full accent-primary" />
        <span className="text-right tabular-nums text-muted-foreground">{size}px</span>
      </label>
      <p className="text-xs text-muted-foreground">{balloon.manual ? "Đặt tay: giữ nguyên chỗ khi khung thay đổi." : "Tự động: tự tránh mặt nhân vật và các lời khác."}</p>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!dirty || !text.trim()}>
            Lưu
          </Button>
          {balloon.manual ? (
            <Button type="button" size="sm" variant="outline" onClick={onReset}>
              Về tự động
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
            Xoá lời này
          </Button>
        </div>
      ) : null}
    </form>
  );
}
