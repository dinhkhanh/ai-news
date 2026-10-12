import type { ComicDoc } from "@ai-news/video/comic";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { acceptSheet, castAction, drawSheets } from "../actions";
import { SheetUpload } from "../library-upload";

type SheetInfo = { ref: string; sheet: { id: string; status: string; url: string } | null };

/**
 * "Nhân vật" (docs/COMIC.md §2.4, §6): one reference sheet per character in the comic's style. Accepting a sheet makes
 * it the character's reference in that style for every later comic; drawing panels uses the latest draft otherwise.
 */
export function CastTab({ comicId, styleId, doc, writer, busy, approved, sheets }: { comicId: string; styleId: string | null; doc: ComicDoc; writer: boolean; busy: boolean; approved: boolean; sheets: SheetInfo[] }) {
  const locked = !writer || busy;
  const missing = sheets.filter((s) => !s.sheet).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Mỗi khung có nhân vật sẽ gửi kèm bản mẫu của họ để giữ nét mặt, trang phục giống nhau. Bản mẫu lưu theo nhân vật × phong cách; truyện sau dùng lại không tốn thêm.
          {approved ? "" : " Nhân vật mới chỉ có bản mẫu sau khi duyệt kịch bản."}
        </p>
        {writer && approved && missing ? (
          <ActionForm action={drawSheets}>
            <input type="hidden" name="comicId" value={comicId} />
            <Button type="submit" disabled={locked}>
              Vẽ {missing} bản mẫu còn thiếu
            </Button>
          </ActionForm>
        ) : null}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {doc.cast.map((c) => {
          const s = sheets.find((x) => x.ref === c.ref)?.sheet ?? null;
          return (
            <Card key={c.ref} className="overflow-hidden pt-0">
              <div className="flex aspect-[3/2] items-center justify-center border-b bg-muted/40">
                {s ? (
                  // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                  <img src={s.url} alt={`Bản mẫu nhân vật ${c.name}`} className="size-full object-contain" />
                ) : (
                  <span className="px-6 text-center text-sm text-muted-foreground">{c.characterId ? "Chưa có bản mẫu trong phong cách này" : "Nhân vật mới: duyệt kịch bản để lưu và vẽ bản mẫu"}</span>
                )}
              </div>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{c.name}</CardTitle>
                  {s ? <Badge variant={s.status === "accepted" ? "success" : "secondary"}>{s.status === "accepted" ? "Đã duyệt" : "Bản nháp"}</Badge> : null}
                </div>
                <CardDescription>{c.role}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {writer ? (
                  <ActionForm action={castAction} className="space-y-2">
                    <input type="hidden" name="comicId" value={comicId} />
                    <input type="hidden" name="ref" value={c.ref} />
                    <input type="hidden" name="op" value="edit" />
                    <input type="hidden" name="name" value={c.name} />
                    <input type="hidden" name="role" value={c.role} />
                    <div className="space-y-1">
                      <Label htmlFor={`visual-${c.ref}`} className="text-xs">
                        Ngoại hình (tiếng Anh, gửi cho mô hình vẽ)
                      </Label>
                      <Textarea id={`visual-${c.ref}`} name="visual" defaultValue={c.visual} rows={3} disabled={locked} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pers-${c.ref}`} className="text-xs">
                        Tính cách, cách nói
                      </Label>
                      <Input id={`pers-${c.ref}`} name="personality" defaultValue={c.personality} disabled={locked} />
                    </div>
                    <Button type="submit" size="sm" variant="outline" disabled={locked}>
                      Lưu mô tả
                    </Button>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-muted-foreground">{c.visual}</p>
                )}
                {writer && c.characterId ? (
                  <div className="flex flex-wrap items-end gap-2">
                    {s && s.status !== "accepted" ? (
                      <ActionForm action={acceptSheet}>
                        <input type="hidden" name="comicId" value={comicId} />
                        <input type="hidden" name="imageId" value={s.id} />
                        <Button type="submit" size="sm" disabled={locked}>
                          Duyệt bản mẫu
                        </Button>
                      </ActionForm>
                    ) : null}
                    {styleId ? <SheetUpload characterId={c.characterId} styleId={styleId} disabled={locked} /> : null}
                    <ActionForm action={drawSheets} className="flex min-w-0 flex-1 items-end gap-2">
                      <input type="hidden" name="comicId" value={comicId} />
                      <input type="hidden" name="ref" value={c.ref} />
                      <Input name="instruction" placeholder="Chỉ dẫn vẽ lại (vd: tóc ngắn hơn)" aria-label="Chỉ dẫn vẽ lại bản mẫu" className="min-w-0 flex-1" disabled={locked} />
                      <Button type="submit" size="sm" variant="outline" disabled={locked}>
                        {s ? "Vẽ lại" : "Vẽ"}
                      </Button>
                    </ActionForm>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
