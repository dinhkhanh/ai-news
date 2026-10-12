import Link from "next/link";
import { asc, eq, isNull, or } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { PAGE_FORMATS } from "@/lib/comic/layout";
import { latestSamples } from "@/lib/comic/library";
import { estimateAdaptUsd, estimateDrawUsd, formatUsd, IMAGE_MODELS, TEXT_MODELS } from "@/lib/comic/models";
import { STORY_LIMITS } from "@/lib/comic/script";
import { presignGet } from "@/lib/r2";
import { canWrite } from "@/lib/workspace";
import { createComic } from "../actions";
import { requireComicsWorkspace } from "../guard";

export const dynamic = "force-dynamic";

/** New comic (docs/COMIC.md §2.1): every option has a default, so pasting a story and pressing «Tạo» works. */
export default async function NewComicPage() {
  const ws = await requireComicsWorkspace();
  const [styles, characters] = await withOrgContext(ws, (tx) =>
    Promise.all([
      tx
        .select({ id: schema.comicStyles.id, name: schema.comicStyles.name, swatch: schema.comicStyles.swatch, colourMode: schema.comicStyles.colourMode, readingDirection: schema.comicStyles.readingDirection, own: schema.comicStyles.organizationId })
        .from(schema.comicStyles)
        .where(or(isNull(schema.comicStyles.organizationId), eq(schema.comicStyles.organizationId, ws.organizationId)))
        .orderBy(asc(schema.comicStyles.position), asc(schema.comicStyles.name)),
      tx.select({ id: schema.comicCharacters.id, name: schema.comicCharacters.name, role: schema.comicCharacters.role }).from(schema.comicCharacters).where(eq(schema.comicCharacters.organizationId, ws.organizationId)).orderBy(asc(schema.comicCharacters.name)),
    ]),
  );
  const writer = canWrite(ws);
  const samples = await latestSamples(ws, styles.map((s) => s.id), 1);
  const sampleUrls = new Map(await Promise.all([...samples.entries()].map(async ([id, list]) => [id, await presignGet(list[0].key, 3600)] as const)));
  // A typical comic: ~7 pages × 4–5 panels, plus 2–3 character sheets.
  const typical = { adapt: estimateAdaptUsd(TEXT_MODELS[0].id, 12_000, 7), flash: estimateDrawUsd(IMAGE_MODELS[0].id, 33), pro: estimateDrawUsd(IMAGE_MODELS[1].id, 33) };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="space-y-1">
        <Link href="/app/comics" className="text-sm text-muted-foreground hover:text-foreground">
          ← Truyện tranh
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Tạo truyện tranh mới</h1>
        <p className="text-sm text-muted-foreground">Dán câu chuyện, chọn phong cách và nhân vật. Kịch bản được duyệt trước khi vẽ, nên chưa tốn tiền ảnh.</p>
      </div>
      {!writer ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">Vai trò của bạn trong workspace chỉ được xem.</CardContent>
        </Card>
      ) : (
        <ActionForm action={createComic} className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Câu chuyện</CardTitle>
              <CardDescription>
                Văn xuôi, có thể có lời thoại; {STORY_LIMITS.min}–{STORY_LIMITS.max.toLocaleString("vi-VN")} ký tự. Cả truyện được gửi cho Claude, không cắt.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">Tên truyện (để trống, Claude sẽ đề xuất)</Label>
                <Input id="title" name="title" maxLength={120} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="story">Nội dung</Label>
                <Textarea id="story" name="story" required minLength={STORY_LIMITS.min} maxLength={STORY_LIMITS.max} rows={18} className="min-h-80 leading-relaxed" placeholder="Đêm Trung thu, Lan tìm thấy chiếc đèn lồng giấy cũ của bà trên gác…" />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Cách chuyển thể</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="free" value="" defaultChecked className="mt-0.5 size-4" />
                  <span>
                    <strong className="font-medium">Trung thành</strong> <span className="text-muted-foreground">— chỉ dùng tình tiết có trong truyện</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="free" value="on" className="mt-0.5 size-4" />
                  <span>
                    <strong className="font-medium">Phóng tác tự do</strong> <span className="text-muted-foreground">— cho phép thêm cảnh nối, lời thoại mới</span>
                  </span>
                </label>
              </fieldset>
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Khuôn khổ</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pagesMode">Số trang</Label>
                  <NativeSelect id="pagesMode" name="pagesMode" defaultValue="auto" className="w-full">
                    <option value="auto">Tự động 5–10</option>
                    <option value="exact">Chọn số trang →</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pages">Số trang (nếu chọn)</Label>
                  <Input id="pages" name="pages" type="number" min={1} max={40} defaultValue={6} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="format">Khổ trang</Label>
                  <NativeSelect id="format" name="format" defaultValue="a4" className="w-full">
                    {PAGE_FORMATS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label} · {f.note}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="readingDirection">Chiều đọc</Label>
                  <NativeSelect id="readingDirection" name="readingDirection" defaultValue="style" className="w-full">
                    <option value="style">Theo phong cách</option>
                    <option value="ltr">Trái → phải</option>
                    <option value="rtl">Phải → trái (manga)</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="language">Ngôn ngữ lời thoại</Label>
                  <NativeSelect id="language" name="language" defaultValue="vi" className="w-full">
                    <option value="vi">Tiếng Việt</option>
                    <option value="en">English</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="audience">Đối tượng</Label>
                  <NativeSelect id="audience" name="audience" defaultValue="general" className="w-full">
                    <option value="kids">Thiếu nhi</option>
                    <option value="general">Phổ thông</option>
                    <option value="adult">Người lớn</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="dialogue">Lượng lời thoại</Label>
                  <NativeSelect id="dialogue" name="dialogue" defaultValue="medium" className="w-full">
                    <option value="low">Ít — để hình kể</option>
                    <option value="medium">Vừa</option>
                    <option value="high">Nhiều</option>
                  </NativeSelect>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Phong cách</CardTitle>
                <CardDescription>
                  Bản mẫu nhân vật được vẽ theo phong cách này và dùng lại ở những truyện sau.{" "}
                  <Link href="/app/comics/styles" className="underline underline-offset-2 hover:text-foreground">
                    Xem, vẽ thử, tạo phong cách
                  </Link>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <legend className="sr-only">Phong cách</legend>
                  {styles.map((s, i) => (
                    <label key={s.id} className="flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-2 has-checked:border-primary has-checked:ring-3 has-checked:ring-primary/20 has-focus-visible:ring-3 has-focus-visible:ring-ring/40">
                      <input type="radio" name="styleId" value={s.id} defaultChecked={i === 1 || styles.length === 1} className="sr-only" />
                      {sampleUrls.get(s.id) ? (
                        // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL
                        <img src={sampleUrls.get(s.id)} alt="" className="block h-14 w-full rounded-md object-cover" />
                      ) : (
                        <span aria-hidden className="block h-14 rounded-md" style={{ background: s.swatch }} />
                      )}
                      <span className="text-xs leading-tight font-medium">
                        {s.name}
                        <span className="block font-normal text-muted-foreground">
                          {s.colourMode === "bw" ? "đen trắng" : "màu"}
                          {s.readingDirection === "rtl" ? " · phải → trái" : ""}
                          {s.own ? " · của workspace" : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Nhân vật</CardTitle>
                <CardDescription>
                  {characters.length ? "Chọn nhân vật đã có. Nhân vật mới trong truyện được đề xuất ở bước kịch bản và lưu vào thư viện khi duyệt." : "Chưa có nhân vật nào trong thư viện: Claude lập danh sách nhân vật từ truyện, bạn duyệt ở bước kịch bản."}{" "}
                  <Link href="/app/comics/characters" className="underline underline-offset-2 hover:text-foreground">
                    Thư viện nhân vật
                  </Link>
                </CardDescription>
              </CardHeader>
              {characters.length ? (
                <CardContent className="flex flex-wrap gap-2">
                  {characters.map((c) => (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm has-checked:border-primary has-checked:bg-primary/10 has-focus-visible:ring-3 has-focus-visible:ring-ring/40">
                      <input type="checkbox" name="castIds" value={c.id} className="size-4" />
                      {c.name}
                      {c.role ? <span className="text-xs text-muted-foreground">{c.role}</span> : null}
                    </label>
                  ))}
                </CardContent>
              ) : null}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Mô hình AI</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="textModel">Viết kịch bản</Label>
                    <NativeSelect id="textModel" name="textModel" defaultValue={TEXT_MODELS[0].id} className="w-full">
                      {TEXT_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} · {m.note}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="imageModel">Vẽ tranh</Label>
                    <NativeSelect id="imageModel" name="imageModel" defaultValue={IMAGE_MODELS[0].id} className="w-full">
                      {IMAGE_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} · {formatUsd(m.usdPerImage)}/ảnh
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="review" defaultChecked className="size-4" />
                  Duyệt kịch bản trước khi vẽ (bỏ chọn = «Vẽ luôn»)
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="qualityGate" className="mt-0.5 size-4" />
                  <span>
                    Kiểm tra chất lượng: Claude so mỗi khung với bản mẫu nhân vật và kịch bản, khung lỗi được vẽ lại một lần (thêm ~$0.01–0.02 mỗi khung, cộng ảnh vẽ lại)
                  </span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Ước tính một truyện ~7 trang, ~33 ảnh: kịch bản ≈ {formatUsd(typical.adapt)}, vẽ ≈ {formatUsd(typical.flash)} (Flash) hoặc ≈ {formatUsd(typical.pro)} (Pro). Con số chính xác hiện khi duyệt kịch bản.
                </p>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-2">
              <Link href="/app/comics" className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted-foreground hover:text-foreground">
                Huỷ
              </Link>
              <Button type="submit">Tạo kịch bản</Button>
            </div>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
