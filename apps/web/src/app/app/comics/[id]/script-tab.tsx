import { LETTERING_KINDS, PAGE_LAYOUTS, PANEL_SIZES, SHOTS, type ComicDoc, type Panel } from "@ai-news/video/comic";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatUsd, imageModel } from "@/lib/comic/models";
import type { ComicRow } from "@/lib/comic/service";
import { appendPanel, approveAndDraw, castAction, changeLayout, readaptComic, removePage, removePanel, rewritePage, savePanel } from "../actions";
import { KIND_LABEL, LAYOUT_LABEL, SHOT_LABEL, SIZE_LABEL } from "../labels";

/**
 * "Kịch bản" (docs/COMIC.md §2.3): the outline before anything is drawn. Every panel is a small form (picture
 * description, size, shot, lettering); pages can be re-laid out or written again by Claude; proposed characters are
 * kept, edited, merged or dropped; "Duyệt & vẽ" shows the estimate and starts the drawing.
 */
export function ScriptTab({ comic, doc, writer, busy, estimate }: { comic: ComicRow; doc: ComicDoc; writer: boolean; busy: boolean; estimate: { panels: number; sheets: number; usd: number } }) {
  const castName = (ref: string | null) => doc.cast.find((c) => c.ref === ref)?.name ?? "—";
  const proposed = doc.cast.filter((c) => !c.characterId);
  const approvable = comic.state === "adapted";
  const locked = !writer || busy;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        {doc.pages.map((page, pi) => (
          <Card key={page.id}>
            <CardHeader>
              <CardTitle>
                Trang {pi + 1} · {page.panels.length} khung
              </CardTitle>
              <CardDescription>{page.beat}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {writer ? (
                <div className="flex flex-wrap items-end gap-2">
                  <ActionForm action={changeLayout} className="flex items-end gap-2">
                    <input type="hidden" name="comicId" value={comic.id} />
                    <input type="hidden" name="pageId" value={page.id} />
                    <div className="space-y-1">
                      <Label htmlFor={`layout-${page.id}`} className="text-xs">
                        Bố cục
                      </Label>
                      <NativeSelect id={`layout-${page.id}`} name="layout" defaultValue={page.layout} fieldSize="sm" disabled={locked}>
                        {PAGE_LAYOUTS.map((l) => (
                          <option key={l} value={l}>
                            {LAYOUT_LABEL[l]}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <Button type="submit" size="sm" variant="outline" disabled={locked}>
                      Đổi
                    </Button>
                  </ActionForm>
                  <ActionForm action={rewritePage} className="flex min-w-60 flex-1 items-end gap-2">
                    <input type="hidden" name="comicId" value={comic.id} />
                    <input type="hidden" name="pageId" value={page.id} />
                    <div className="flex-1 space-y-1">
                      <Label htmlFor={`rw-${page.id}`} className="text-xs">
                        Viết lại trang này theo chỉ dẫn
                      </Label>
                      <Input id={`rw-${page.id}`} name="instruction" placeholder="vd: thêm một khung bà kể chuyện, bớt lời dẫn" disabled={locked} />
                    </div>
                    <Button type="submit" size="sm" variant="outline" disabled={locked}>
                      Viết lại
                    </Button>
                  </ActionForm>
                  {doc.pages.length > 1 ? (
                    <ActionForm action={removePage}>
                      <input type="hidden" name="comicId" value={comic.id} />
                      <input type="hidden" name="pageId" value={page.id} />
                      <Button type="submit" size="sm" variant="destructive" disabled={locked}>
                        Xoá trang
                      </Button>
                    </ActionForm>
                  ) : null}
                </div>
              ) : null}

              <ol className="space-y-3">
                {page.panels.map((k, ki) => (
                  <li key={k.id} className="rounded-lg border p-3">
                    <PanelForm comicId={comic.id} doc={doc} panel={k} index={ki} locked={locked} castName={castName} />
                  </li>
                ))}
              </ol>

              {writer ? (
                <ActionForm action={appendPanel} className="flex items-end gap-2" resetOnSuccess>
                  <input type="hidden" name="comicId" value={comic.id} />
                  <input type="hidden" name="pageId" value={page.id} />
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`add-${page.id}`} className="text-xs">
                      Thêm khung (mô tả hình bằng tiếng Anh)
                    </Label>
                    <Input id={`add-${page.id}`} name="description" placeholder="Close-up of the lantern glowing in Lan's hands" disabled={locked} />
                  </div>
                  <Button type="submit" size="sm" variant="outline" disabled={locked}>
                    Thêm
                  </Button>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      <aside className="space-y-5 lg:sticky lg:top-4">
        {proposed.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Nhân vật mới tìm thấy</CardTitle>
              <CardDescription>Giữ (sửa mô tả nếu cần), gộp với nhân vật khác, hoặc bỏ. Khi duyệt, nhân vật được lưu vào thư viện.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {proposed.map((c) => (
                <div key={c.ref} className="space-y-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
                  <ActionForm action={castAction} className="space-y-2">
                    <input type="hidden" name="comicId" value={comic.id} />
                    <input type="hidden" name="ref" value={c.ref} />
                    <input type="hidden" name="op" value="edit" />
                    <Input name="name" defaultValue={c.name} aria-label="Tên" disabled={locked} />
                    <Input name="role" defaultValue={c.role} aria-label="Vai trò" disabled={locked} />
                    <Textarea name="visual" defaultValue={c.visual} aria-label="Ngoại hình (tiếng Anh)" rows={3} disabled={locked} />
                    <input type="hidden" name="personality" value={c.personality} />
                    <Button type="submit" size="sm" disabled={locked}>
                      Lưu
                    </Button>
                  </ActionForm>
                  <div className="flex flex-wrap gap-2">
                    {doc.cast.length > 1 ? (
                      <ActionForm action={castAction} className="flex items-center gap-1">
                        <input type="hidden" name="comicId" value={comic.id} />
                        <input type="hidden" name="ref" value={c.ref} />
                        <input type="hidden" name="op" value="merge" />
                        <NativeSelect name="into" fieldSize="sm" aria-label="Gộp vào" disabled={locked}>
                          {doc.cast
                            .filter((x) => x.ref !== c.ref)
                            .map((x) => (
                              <option key={x.ref} value={x.ref}>
                                {x.name}
                              </option>
                            ))}
                        </NativeSelect>
                        <Button type="submit" size="sm" variant="outline" disabled={locked}>
                          Gộp
                        </Button>
                      </ActionForm>
                    ) : null}
                    <ActionForm action={castAction}>
                      <input type="hidden" name="comicId" value={comic.id} />
                      <input type="hidden" name="ref" value={c.ref} />
                      <input type="hidden" name="op" value="drop" />
                      <Button type="submit" size="sm" variant="destructive" disabled={locked}>
                        Bỏ
                      </Button>
                    </ActionForm>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{approvable ? "Trước khi vẽ" : "Kịch bản đã duyệt"}</CardTitle>
            <CardDescription>
              {estimate.panels} khung chưa vẽ · {estimate.sheets} bản mẫu nhân vật · {imageModel(comic.imageModel).label}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xl font-semibold tabular-nums">≈ {formatUsd(estimate.usd)}</p>
            {writer && approvable ? (
              <ActionForm action={approveAndDraw}>
                <input type="hidden" name="comicId" value={comic.id} />
                <Button type="submit" className="w-full" disabled={busy}>
                  Duyệt &amp; vẽ
                </Button>
              </ActionForm>
            ) : null}
            <p className="text-xs text-muted-foreground">{approvable ? "Chưa tốn tiền ảnh cho tới khi bấm." : "Sửa kịch bản vẫn được: khung đã vẽ giữ hình, khung mới vẽ ở tab Trang."}</p>
            {writer ? (
              <ActionForm action={readaptComic}>
                <input type="hidden" name="comicId" value={comic.id} />
                <Button type="submit" size="sm" variant="ghost" className="w-full" disabled={busy}>
                  Viết lại toàn bộ kịch bản
                </Button>
              </ActionForm>
            ) : null}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function PanelForm({ comicId, doc, panel, index, locked, castName }: { comicId: string; doc: ComicDoc; panel: Panel; index: number; locked: boolean; castName: (ref: string | null) => string }) {
  const rows = [...panel.lettering.map((b) => ({ kind: b.kind, speaker: b.speaker, text: b.text })), { kind: "speech" as const, speaker: panel.script.characters[0]?.ref ?? null, text: "" }].slice(0, 4);
  const who = panel.script.characters.map((c) => `${castName(c.ref)} (${c.position})`).join(", ");
  return (
    <div className="space-y-2">
      <ActionForm action={savePanel} className="space-y-2">
        <input type="hidden" name="comicId" value={comicId} />
        <input type="hidden" name="panelId" value={panel.id} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Khung {index + 1}</span>
          <NativeSelect name="size" defaultValue={panel.script.size} fieldSize="sm" aria-label="Cỡ khung" disabled={locked}>
            {PANEL_SIZES.map((s) => (
              <option key={s} value={s}>
                {SIZE_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect name="shot" defaultValue={panel.script.shot} fieldSize="sm" aria-label="Góc máy" disabled={locked}>
            {SHOTS.map((s) => (
              <option key={s} value={s}>
                {SHOT_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
          {who ? <span className="text-xs text-muted-foreground">{who}</span> : null}
          {panel.image ? <span className="text-xs font-medium text-success">đã vẽ</span> : null}
        </div>
        <Textarea name="description" defaultValue={panel.script.description} rows={2} aria-label="Mô tả hình (tiếng Anh)" disabled={locked} />
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <NativeSelect name={`kind_${i}`} defaultValue={r.kind} fieldSize="sm" aria-label="Loại lời" disabled={locked}>
                {LETTERING_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect name={`speaker_${i}`} defaultValue={r.speaker ?? ""} fieldSize="sm" aria-label="Người nói" disabled={locked}>
                <option value="">—</option>
                {doc.cast.map((c) => (
                  <option key={c.ref} value={c.ref}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
              <Input name={`text_${i}`} defaultValue={r.text} placeholder={i === rows.length - 1 ? "Thêm lời…" : ""} aria-label="Lời" className="min-w-48 flex-1" disabled={locked} />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={locked}>
            Lưu khung
          </Button>
        </div>
      </ActionForm>
      <ActionForm action={removePanel}>
        <input type="hidden" name="comicId" value={comicId} />
        <input type="hidden" name="panelId" value={panel.id} />
        <Button type="submit" size="xs" variant="ghost" className="text-destructive" disabled={locked}>
          Xoá khung
        </Button>
      </ActionForm>
    </div>
  );
}
