import Link from "next/link";
import { asc, eq, isNull, or } from "drizzle-orm";
import { COMIC_FONTS } from "@ai-news/video/comic";
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
import { latestSamples, MAX_REFS } from "@/lib/comic/library";
import { formatUsd, IMAGE_MODELS } from "@/lib/comic/models";
import { presignGet } from "@/lib/r2";
import { canWrite } from "@/lib/workspace";
import { ComicTabs } from "../comic-tabs";
import { requireComicsWorkspace } from "../guard";
import { deleteStyle, drawStyleSample, duplicateStyle, saveStyle } from "../library-actions";
import { ReferenceImages } from "../library-upload";

export const dynamic = "force-dynamic";
// "Vẽ thử" draws one picture inside the request.
export const maxDuration = 120;

type StyleRow = typeof schema.comicStyles.$inferSelect;

/**
 * Art styles (docs/COMIC.md §6): the platform presets and the workspace's own. A style is an English art direction
 * for the image model, things to avoid, storytelling notes for the adaptation and up to four sample images sent with
 * every panel. "Vẽ thử" draws the same test scene in any style, so they can be compared.
 */
export default async function ComicStylesPage({ searchParams }: { searchParams: Promise<{ edit?: string; new?: string }> }) {
  const ws = await requireComicsWorkspace();
  const writer = canWrite(ws);
  const sp = await searchParams;
  const rows = await withOrgContext(ws, (tx) =>
    tx
      .select()
      .from(schema.comicStyles)
      .where(or(isNull(schema.comicStyles.organizationId), eq(schema.comicStyles.organizationId, ws.organizationId)))
      .orderBy(asc(schema.comicStyles.position), asc(schema.comicStyles.name)),
  );
  const mine = rows.filter((r) => r.organizationId);
  const presets = rows.filter((r) => !r.organizationId);
  const editing = sp.edit ? mine.find((r) => r.id === sp.edit) : undefined;
  const samples = await latestSamples(ws, rows.map((r) => r.id));
  const keys = [...new Set([...[...samples.values()].flat().map((s) => s.key), ...mine.flatMap((r) => r.referenceKeys)])];
  const urls = new Map(await Promise.all(keys.map(async (k) => [k, await presignGet(k, 3600)] as const)));

  return (
    <div className="mx-auto max-w-6xl space-y-5 sm:space-y-6">
      <ComicTabs active="styles" />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Phong cách quyết định cách vẽ mọi khung và bản mẫu nhân vật. Truyện giữ bản sao phong cách lúc tạo, nên sửa phong cách chỉ ảnh hưởng truyện tạo sau. “Vẽ thử” vẽ cùng một cảnh trong từng phong cách để so sánh (một ảnh, ≈{" "}
        {formatUsd(IMAGE_MODELS[0].usdPerImage)}).
      </p>

      {writer && (editing || sp.new) ? <StyleEditor style={editing} refs={(editing?.referenceKeys ?? []).map((k) => ({ key: k, url: urls.get(k) ?? "" }))} /> : null}
      {writer && !editing && !sp.new ? (
        <Link href="/app/comics/styles?new=1#editor" className={buttonVariants({ variant: "outline" })}>
          Phong cách mới
        </Link>
      ) : null}

      <section aria-labelledby="mine-h" className="space-y-2">
        <h2 id="mine-h" className="px-1 text-sm font-medium text-muted-foreground">
          Của workspace · {mine.length}
        </h2>
        {mine.length ? (
          <StyleGrid styles={mine} samples={samples} urls={urls} writer={writer} own />
        ) : (
          <p className="px-1 text-sm text-muted-foreground">Chưa có. Nhân bản một phong cách mẫu bên dưới để chỉnh theo ý, hoặc tạo mới.</p>
        )}
      </section>
      <section aria-labelledby="presets-h" className="space-y-2">
        <h2 id="presets-h" className="px-1 text-sm font-medium text-muted-foreground">
          Phong cách mẫu · {presets.length}
        </h2>
        <StyleGrid styles={presets} samples={samples} urls={urls} writer={writer} own={false} />
      </section>
    </div>
  );
}

function StyleGrid({ styles, samples, urls, writer, own }: { styles: StyleRow[]; samples: Awaited<ReturnType<typeof latestSamples>>; urls: Map<string, string>; writer: boolean; own: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {styles.map((s) => {
        const list = samples.get(s.id) ?? [];
        return (
          <Card key={s.id} className="overflow-hidden pt-0">
            <div className="grid aspect-[4/3] grid-cols-3 gap-px border-b bg-muted" style={list.length ? undefined : { background: s.swatch }}>
              {list.map((x, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                <img key={x.id} src={urls.get(x.key)} alt={`Vẽ thử ${i + 1} của ${s.name}`} className={i === 0 ? "col-span-2 row-span-2 size-full object-cover" : "size-full object-cover"} />
              ))}
            </div>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{s.name}</CardTitle>
                <div className="flex gap-1">
                  <Badge variant="secondary">{s.colourMode === "bw" ? "đen trắng" : "màu"}</Badge>
                  {s.readingDirection === "rtl" ? <Badge variant="secondary">phải → trái</Badge> : null}
                </div>
              </div>
              <CardDescription className="line-clamp-3">{s.prompt}</CardDescription>
            </CardHeader>
            {writer ? (
              <CardContent className="space-y-2">
                <ActionForm action={drawStyleSample} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={s.id} />
                  <NativeSelect name="imageModel" fieldSize="sm" aria-label="Mô hình vẽ thử" defaultValue={IMAGE_MODELS[0].id} className="min-w-0 flex-1">
                    {IMAGE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button type="submit" size="sm" variant="outline">
                    Vẽ thử
                  </Button>
                </ActionForm>
                <div className="flex flex-wrap gap-2">
                  {own ? (
                    <Link href={`/app/comics/styles?edit=${s.id}#editor`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                      Sửa
                    </Link>
                  ) : null}
                  <ActionForm action={duplicateStyle}>
                    <input type="hidden" name="id" value={s.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      Nhân bản
                    </Button>
                  </ActionForm>
                </div>
              </CardContent>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

function StyleEditor({ style, refs }: { style?: StyleRow; refs: { key: string; url: string }[] }) {
  return (
    <Card id="editor">
      <CardHeader>
        <CardTitle>{style ? `Sửa “${style.name}”` : "Phong cách mới"}</CardTitle>
        <CardDescription>Viết mô tả cho mô hình vẽ bằng tiếng Anh: chất liệu, nét, màu, đổ bóng, thời kỳ. Tả kỹ thuật, đừng nêu tên hoạ sĩ hay thương hiệu.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ActionForm action={saveStyle} className="grid gap-3 sm:grid-cols-2">
          {style ? <input type="hidden" name="id" value={style.id} /> : null}
          <div className="space-y-1.5">
            <Label htmlFor="st-name">Tên</Label>
            <Input id="st-name" name="name" required maxLength={60} defaultValue={style?.name} />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="st-colour">Màu</Label>
              <NativeSelect id="st-colour" name="colourMode" defaultValue={style?.colourMode ?? "colour"} className="w-full">
                <option value="colour">Màu</option>
                <option value="bw">Đen trắng</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-swatch">Màu thẻ</Label>
              <input id="st-swatch" name="swatch" type="color" defaultValue={/^#[0-9a-f]{6}$/i.test(style?.swatch ?? "") ? style!.swatch : "#e4e4e7"} className="h-9 w-12 rounded-md border bg-card p-1" />
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="st-prompt">Mô tả phong cách (tiếng Anh, gửi cho mô hình vẽ)</Label>
            <Textarea id="st-prompt" name="prompt" required minLength={20} maxLength={1000} rows={4} defaultValue={style?.prompt} placeholder="clean digital line art, flat pastel colours, soft cel shading, expressive faces, light paper texture" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="st-neg">Tránh (tiếng Anh)</Label>
            <Input id="st-neg" name="negative" maxLength={500} defaultValue={style?.negative} placeholder="photorealism, 3D render, heavy gradients" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="st-notes">Cách kể chuyện (gửi cho Claude khi viết kịch bản)</Label>
            <Textarea id="st-notes" name="storytellingNotes" maxLength={1000} rows={2} defaultValue={style?.storytellingNotes} placeholder="nhiều khung im lặng, cận cảnh phản ứng, 4–5 khung mỗi trang" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-font">Phông chữ lời thoại</Label>
            <NativeSelect id="st-font" name="font" defaultValue={style?.font ?? "itim"} className="w-full">
              {Object.entries(COMIC_FONTS).map(([id, f]) => (
                <option key={id} value={id}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-dir">Chiều đọc mặc định</Label>
            <NativeSelect id="st-dir" name="readingDirection" defaultValue={style?.readingDirection ?? "ltr"} className="w-full">
              <option value="ltr">Trái → phải</option>
              <option value="rtl">Phải → trái (manga)</option>
            </NativeSelect>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit">{style ? "Lưu" : "Tạo phong cách"}</Button>
            <Link href="/app/comics/styles" className={buttonVariants({ variant: "ghost" })}>
              Đóng
            </Link>
          </div>
        </ActionForm>
        {style ? (
          <>
            <div className="space-y-2 border-t pt-4">
              <h3 className="text-sm font-medium">Hình mẫu phong cách</h3>
              <ReferenceImages
                target="style"
                id={style.id}
                items={refs}
                max={MAX_REFS}
                canEdit
                hint={`Tối đa ${MAX_REFS} hình, gửi kèm mọi khung để giữ đúng nét vẽ (mô hình học kỹ thuật, không chép nội dung). Có thể thêm từ trang truyện: chọn một khung đẹp → “Dùng hình này làm mẫu phong cách”.`}
              />
            </div>
            <ActionForm action={deleteStyle} className="border-t pt-4">
              <input type="hidden" name="id" value={style.id} />
              <Button type="submit" size="sm" variant="destructive">
                Xoá phong cách
              </Button>
            </ActionForm>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
