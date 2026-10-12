import Link from "next/link";
import { asc, eq, isNull, or } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { MAX_REFS, sheetsOfCharacters } from "@/lib/comic/library";
import { formatUsd, IMAGE_MODELS } from "@/lib/comic/models";
import { presignGet } from "@/lib/r2";
import { canWrite } from "@/lib/workspace";
import { ComicTabs } from "../comic-tabs";
import { requireComicsWorkspace } from "../guard";
import { acceptCharacterSheet, deleteCharacter, drawCharacterSheet, saveCharacter } from "../library-actions";
import { ReferenceImages, SheetUpload } from "../library-upload";

export const dynamic = "force-dynamic";
// Drawing a sheet runs inside the request.
export const maxDuration = 120;

type CharacterRow = typeof schema.comicCharacters.$inferSelect;
type Sheet = Awaited<ReturnType<typeof sheetsOfCharacters>>[number];

/**
 * Reusable characters (docs/COMIC.md §6): how they look (English, for the image model), how they talk (for the
 * adaptation), reference photos or drawings, and one sheet per art style. An accepted sheet is what every panel of
 * every comic in that style sends to keep the character recognisable; it can be drawn here or uploaded.
 */
export default async function ComicCharactersPage({ searchParams }: { searchParams: Promise<{ edit?: string; new?: string }> }) {
  const ws = await requireComicsWorkspace();
  const writer = canWrite(ws);
  const sp = await searchParams;
  const [characters, styles] = await withOrgContext(ws, (tx) =>
    Promise.all([
      tx.select().from(schema.comicCharacters).where(eq(schema.comicCharacters.organizationId, ws.organizationId)).orderBy(asc(schema.comicCharacters.name)),
      tx
        .select({ id: schema.comicStyles.id, name: schema.comicStyles.name, own: schema.comicStyles.organizationId })
        .from(schema.comicStyles)
        .where(or(isNull(schema.comicStyles.organizationId), eq(schema.comicStyles.organizationId, ws.organizationId)))
        .orderBy(asc(schema.comicStyles.position), asc(schema.comicStyles.name)),
    ]),
  );
  const sheets = await sheetsOfCharacters(ws, characters.map((c) => c.id));
  const editing = sp.edit ? characters.find((c) => c.id === sp.edit) : undefined;
  const cover = (c: CharacterRow) => sheets.find((s) => s.characterId === c.id && s.status === "accepted")?.key ?? sheets.find((s) => s.characterId === c.id)?.key ?? c.referenceKeys[0] ?? null;
  const keys = new Set<string>([...characters.map(cover).filter((k): k is string => Boolean(k)), ...(editing ? [...editing.referenceKeys, ...sheets.filter((s) => s.characterId === editing.id).map((s) => s.key)] : [])]);
  const urls = new Map(await Promise.all([...keys].map(async (k) => [k, await presignGet(k, 3600)] as const)));

  return (
    <div className="mx-auto max-w-6xl space-y-5 sm:space-y-6">
      <ComicTabs active="characters" />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Nhân vật dùng lại được ở nhiều truyện. Nhân vật mới trong một truyện được lưu vào đây khi duyệt kịch bản. Mỗi phong cách có một bản mẫu đã duyệt; khung nào có nhân vật sẽ gửi kèm bản mẫu đó để giữ nét mặt, trang phục.
      </p>

      {writer && (editing || sp.new) ? (
        <CharacterEditor
          character={editing}
          styles={styles}
          sheets={editing ? sheets.filter((s) => s.characterId === editing.id) : []}
          urls={urls}
        />
      ) : null}
      {writer && !editing && !sp.new ? (
        <Link href="/app/comics/characters?new=1#editor" className={buttonVariants({ variant: "outline" })}>
          Nhân vật mới
        </Link>
      ) : null}

      {characters.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {characters.map((c) => {
            const k = cover(c);
            const n = sheets.filter((s) => s.characterId === c.id && s.status === "accepted").length;
            return (
              <li key={c.id}>
                <Card className="h-full overflow-hidden pt-0">
                  <div className="flex aspect-[3/2] items-center justify-center border-b bg-muted/40">
                    {k ? (
                      // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                      <img src={urls.get(k)} alt={`Hình của ${c.name}`} className="size-full object-contain" />
                    ) : (
                      <span className="text-sm text-muted-foreground">Chưa có hình</span>
                    )}
                  </div>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle>{c.name}</CardTitle>
                      <Badge variant={n ? "success" : "secondary"}>{n ? `${n} bản mẫu` : "chưa có bản mẫu"}</Badge>
                    </div>
                    <CardDescription>{c.role}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="line-clamp-3 text-xs text-muted-foreground">{c.visual}</p>
                    {writer ? (
                      <Link href={`/app/comics/characters?edit=${c.id}#editor`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                        Sửa, bản mẫu
                      </Link>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Chưa có nhân vật nào. Tạo ở đây, hoặc để Claude đề xuất từ truyện rồi duyệt kịch bản.</p>
      )}
    </div>
  );
}

function CharacterEditor({ character, styles, sheets, urls }: { character?: CharacterRow; styles: { id: string; name: string; own: string | null }[]; sheets: Sheet[]; urls: Map<string, string> }) {
  const byStyle = styles.map((s) => ({ style: s, list: sheets.filter((x) => x.styleId === s.id).sort((a, b) => Number(b.status === "accepted") - Number(a.status === "accepted")).slice(0, 4) }));
  return (
    <Card id="editor">
      <CardHeader>
        <CardTitle>{character ? `Sửa “${character.name}”` : "Nhân vật mới"}</CardTitle>
        <CardDescription>Ngoại hình viết bằng tiếng Anh cho mô hình vẽ: tuổi, dáng người, khuôn mặt, tóc, trang phục và màu, một món đồ riêng dễ nhận ra. Không dựa trên người thật hay nhân vật có bản quyền.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ActionForm action={saveCharacter} className="grid gap-3 sm:grid-cols-2">
          {character ? <input type="hidden" name="id" value={character.id} /> : null}
          <div className="space-y-1.5">
            <Label htmlFor="ch-name">Tên</Label>
            <Input id="ch-name" name="name" required maxLength={80} defaultValue={character?.name} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ch-role">Vai trò</Label>
            <Input id="ch-role" name="role" maxLength={200} defaultValue={character?.role} placeholder="cô bé 8 tuổi, nhân vật chính" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ch-visual">Ngoại hình (tiếng Anh)</Label>
            <Textarea id="ch-visual" name="visual" required minLength={15} maxLength={1000} rows={3} defaultValue={character?.visual} placeholder="8-year-old girl, small and quick, round face, black bob with a red clip, pink T-shirt, denim shorts, yellow sandals" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ch-pers">Tính cách, cách nói (Claude dùng khi viết lời thoại)</Label>
            <Input id="ch-pers" name="personality" maxLength={500} defaultValue={character?.personality} placeholder="tò mò, nói nhanh, hay hỏi “tại sao”" />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit">{character ? "Lưu" : "Tạo nhân vật"}</Button>
            <Link href="/app/comics/characters" className={buttonVariants({ variant: "ghost" })}>
              Đóng
            </Link>
          </div>
        </ActionForm>

        {character ? (
          <>
            <div className="space-y-2 border-t pt-4">
              <h3 className="text-sm font-medium">Ảnh tham chiếu</h3>
              <ReferenceImages
                target="character"
                id={character.id}
                items={character.referenceKeys.map((k) => ({ key: k, url: urls.get(k) ?? "" }))}
                max={MAX_REFS}
                canEdit
                hint={`Ảnh chụp hoặc tranh vẽ ngoại hình (tối đa ${MAX_REFS}), gửi kèm khi vẽ bản mẫu để nhân vật giống ý bạn; mô hình vẽ lại theo phong cách.`}
              />
            </div>

            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-medium">Bản mẫu theo phong cách</h3>
              <ActionForm action={drawCharacterSheet} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
                <input type="hidden" name="id" value={character.id} />
                <div className="space-y-1">
                  <Label htmlFor="sh-style" className="text-xs">
                    Phong cách
                  </Label>
                  <NativeSelect id="sh-style" name="styleId" fieldSize="sm" className="w-full">
                    {styles.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.own ? " · workspace" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sh-model" className="text-xs">
                    Mô hình
                  </Label>
                  <NativeSelect id="sh-model" name="imageModel" fieldSize="sm" defaultValue={IMAGE_MODELS[0].id} className="w-full">
                    {IMAGE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {formatUsd(m.usdPerImage)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sh-instr" className="text-xs">
                    Chỉ dẫn (tuỳ chọn)
                  </Label>
                  <Input id="sh-instr" name="instruction" maxLength={1000} placeholder="vd: tóc ngắn hơn, áo khoác xanh" />
                </div>
                <Button type="submit" size="sm">
                  Vẽ bản mẫu
                </Button>
              </ActionForm>
              <ul className="divide-y rounded-lg border">
                {byStyle.map(({ style, list }) => (
                  <li key={style.id} className="flex flex-wrap items-center gap-3 p-3">
                    <span className="w-40 shrink-0 text-sm">{style.name}</span>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                      {list.length ? (
                        list.map((s) => (
                          <div key={s.id} className="space-y-1">
                            {/* eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL */}
                            <img src={urls.get(s.key)} alt={`Bản mẫu ${style.name}`} className={`h-20 w-30 rounded-md border bg-muted object-contain ${s.status === "accepted" ? "ring-2 ring-success" : ""}`} />
                            {s.status === "accepted" ? (
                              <p className="text-[11px] text-success">Đã duyệt{s.model === "upload" ? " · ảnh tải lên" : ""}</p>
                            ) : (
                              <ActionForm action={acceptCharacterSheet}>
                                <input type="hidden" name="imageId" value={s.id} />
                                <Button type="submit" size="sm" variant="ghost" className="h-6 px-1 text-[11px]">
                                  Duyệt
                                </Button>
                              </ActionForm>
                            )}
                          </div>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">chưa có</span>
                      )}
                    </div>
                    <SheetUpload characterId={character.id} styleId={style.id} />
                  </li>
                ))}
              </ul>
            </div>

            <ActionForm action={deleteCharacter} className="border-t pt-4">
              <input type="hidden" name="id" value={character.id} />
              <Button type="submit" size="sm" variant="destructive">
                Xoá nhân vật
              </Button>
            </ActionForm>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
