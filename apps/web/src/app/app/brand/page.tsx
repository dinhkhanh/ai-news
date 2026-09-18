import Link from "next/link";
import { Eye, Image as ImageIcon, LayoutGrid, Palette, Save, Type } from "lucide-react";
import { BRAND_FONTS, CAPTION_FONT_RANGE, HEADLINE_FONT_RANGE } from "@ai-news/video/schema";
import { ActionForm } from "@/components/action-form";
import { SectionTabs, StickyToolbar } from "@/components/sticky-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { brandFromRow, listBrandKits } from "@/lib/media/brand";
import { cn } from "@/lib/utils";
import { presignGet } from "@/lib/r2";
import { requireWorkspace } from "@/lib/workspace";
import { deleteBrandKit, duplicateBrandKit, saveBrandKit, setDefaultBrandKit } from "./actions";
import { BrandPreviewLoader } from "./brand-preview-loader";
import { ColourField } from "./colour-field";
import { OverlayUploader } from "./overlay-uploader";

export const dynamic = "force-dynamic";

const FORM_ID = "brand-kit-form";

function Px({ name, label, value, min, max, placeholder, hint }: { name: string; label: string; value: number | null; min: number; max: number; placeholder?: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type="number" inputMode="numeric" step={1} min={min} max={max} defaultValue={value ?? ""} placeholder={placeholder} className="tabular-nums" />
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Colour (with opacity; 0% = no shadow) + blur + offset of one text box's shadow. */
function ShadowFields({ prefix, label, value }: { prefix: string; label: string; value: { colour: string; blur: number; x: number; y: number } }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
      <ColourField name={`${prefix}Colour`} label={label} value={value.colour} hint="Độ đậm 0% = không có bóng." />
      <Px name={`${prefix}Blur`} label="Độ nhoè (0–200)" min={0} max={200} value={value.blur} />
      <Px name={`${prefix}X`} label="Lệch ngang" min={-200} max={200} value={value.x} />
      <Px name={`${prefix}Y`} label="Lệch dọc" min={-200} max={200} value={value.y} />
    </div>
  );
}

function F({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect id={name} name={name} defaultValue={value} className="w-full">
        {BRAND_FONTS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export default async function BrandPage({ searchParams }: { searchParams: Promise<{ kit?: string }> }) {
  const ws = await requireWorkspace();
  const sp = await searchParams;
  const kits = await listBrandKits(ws);
  const canEdit = ws.isAdmin || ["admin", "owner", "publisher"].includes(ws.role);
  const creating = sp.kit === "new" || kits.length === 0;
  const row = creating ? null : (kits.find((k) => k.id === sp.kit) ?? kits[0]);
  const { brand } = brandFromRow(row);
  const sign = async (key: string | null | undefined) => {
    if (!key) return null;
    try {
      return await presignGet(key, 600);
    } catch {
      return null;
    }
  };
  const [logoUrl, overlayUrl, thumbs] = await Promise.all([sign(row?.logoPath), sign(row?.overlayPath), Promise.all(kits.map((k) => sign(k.overlayPath)))]);
  const autoKits = kits.filter((k) => k.autoMatch && !k.isDefault).length;

  return (
    <div className="mx-auto max-w-6xl space-y-4 sm:space-y-6">
      <div className="band-head relative">
        <h1 className="sr-only">Bộ nhận diện</h1>
        <p className="text-sm text-muted-foreground">
          Workspace {ws.name}. Mỗi bộ là một “diện mạo” cho một loại tin: màu, font (hỗ trợ tiếng Việt), logo, lớp phủ PNG, kiểu phụ đề. Khi tạo dự án, hệ thống tự chọn bộ khớp nội dung bài
          (theo mô tả + từ khoá) hoặc bạn chọn tay; không bộ nào khớp thì dùng bộ mặc định. Thay đổi áp dụng cho các lần dựng timeline tiếp theo.
        </p>
      </div>

      <StickyToolbar
        tabs={
          <SectionTabs
            tabs={[
              { id: "kits", label: "Các bộ", icon: <LayoutGrid /> },
              { id: "basics", label: "Cơ bản", icon: <Palette /> },
              { id: "text", label: "Chữ", icon: <Type /> },
              { id: "logo", label: "Logo & lớp phủ", icon: <ImageIcon /> },
              { id: "preview", label: "Xem trước", icon: <Eye /> },
            ]}
          />
        }
      >
        <Button type="submit" form={FORM_ID} disabled={!canEdit}>
          <Save /> {row ? "Lưu bộ nhận diện" : "Tạo bộ nhận diện"}
        </Button>
        {canEdit && !creating ? (
          <Button variant="outline" render={<Link href="/app/brand?kit=new" />}>
            + Bộ mới
          </Button>
        ) : null}
        <span className="ml-auto pl-2 text-xs text-muted-foreground">{row ? row.name : "bộ mới"}</span>
      </StickyToolbar>

      <div id="kits" className="grid gap-3 scroll-mt-40 sm:grid-cols-2 lg:grid-cols-3">
        {kits.map((k, i) => (
          <Link key={k.id} href={`/app/brand?kit=${k.id}`} aria-current={row?.id === k.id ? "true" : undefined} className={cn("flex gap-3 rounded-xl bg-card p-3 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/50", row?.id === k.id && "ring-2 ring-primary")}>
            <div className="relative aspect-[9/16] w-12 shrink-0 overflow-hidden rounded border" style={{ background: `linear-gradient(160deg, ${k.colours.primary ?? "#0f172a"}, ${k.colours.background ?? "#0b1220"})` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {thumbs[i] ? <img src={thumbs[i]} alt="" className="absolute inset-0 h-full w-full" loading="lazy" /> : null}
              <span className="absolute bottom-1 left-1 h-1.5 w-5 rounded-full" style={{ background: k.colours.accent ?? "#f59e0b" }} />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="truncate text-sm font-medium">{k.name}</div>
              <div className="flex flex-wrap gap-1">
                {k.isDefault ? <Badge>mặc định</Badge> : null}
                {k.overlayPath ? <Badge variant="outline">lớp phủ</Badge> : null}
                {!k.isDefault ? <Badge variant="secondary">{k.autoMatch ? "tự chọn" : "chỉ chọn tay"}</Badge> : null}
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{k.description || (k.isDefault ? "Dùng khi không bộ nào khớp." : "Chưa có mô tả: bộ chọn tự động sẽ khó khớp.")}</p>
            </div>
          </Link>
        ))}
        {canEdit ? (
          <Link href="/app/brand?kit=new" className={cn("grid min-h-24 place-items-center rounded-xl border border-dashed p-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50", creating && kits.length > 0 && "border-primary text-foreground")}>
            + Bộ nhận diện mới
          </Link>
        ) : null}
      </div>
      {kits.length > 1 && autoKits === 0 ? <p className="text-xs text-amber-700 dark:text-amber-400">Chưa bộ nào bật “tự chọn theo nội dung”, nên mọi dự án dùng bộ mặc định trừ khi chọn tay.</p> : null}

      <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4 sm:space-y-6">
      <Card id="basics" className="scroll-mt-40">
        <CardHeader>
          <CardTitle className="text-base">{row ? row.name : kits.length ? "Bộ nhận diện mới" : "Chưa có bộ nhận diện riêng (đang dùng mặc định của hệ thống)"}</CardTitle>
          <CardDescription>Vùng an toàn cố định cho 1080×1920: trên 220 px, dưới 420 px, trái 60 px, phải 180 px.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm key={row?.id ?? "new"} id={FORM_ID} action={saveBrandKit} className="space-y-4">
            <input type="hidden" name="id" value={row?.id ?? ""} />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="name">Tên (nói rõ dùng cho gì)</Label>
                <Input id="name" name="name" required minLength={2} maxLength={60} defaultValue={row?.name ?? ""} placeholder="Thể thao · Kinh tế · Công nghệ · Tin nóng…" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="outroText">Dòng kết (outro)</Label>
                <Input id="outroText" name="outroText" defaultValue={brand.outroText ?? ""} placeholder="Theo dõi để cập nhật tin mới" />
              </div>
            </div>
            <CollapsibleSection variant="plain" defaultOpen="desktop" title="Tự chọn theo nội dung bài" summary={row?.autoMatch === false ? "chỉ chọn tay" : (row?.matchKeywords?.length ?? 0) ? `${row!.matchKeywords.length} từ khoá` : "chưa có từ khoá"} className="rounded-lg border px-3 [&>summary]:px-0" bodyClassName="space-y-3 pb-3">
              <div className="space-y-1">
                <Label htmlFor="description">Bộ này dành cho loại tin nào?</Label>
                <Textarea id="description" name="description" rows={2} maxLength={400} defaultValue={row?.description ?? ""} placeholder="Tin thể thao: bóng đá trong nước và quốc tế, SEA Games, Olympic, chuyển nhượng cầu thủ…" className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="matchKeywords">Từ khoá (phân cách bằng dấu phẩy, tối đa 30)</Label>
                <Input id="matchKeywords" name="matchKeywords" defaultValue={(row?.matchKeywords ?? []).join(", ")} placeholder="bóng đá, V-League, HLV, đội tuyển, huy chương" />
                <p className="text-[11px] text-muted-foreground">Haiku đọc mô tả + từ khoá để chọn bộ; nếu mô hình không sẵn sàng thì đếm từ khoá (không phân biệt dấu). Bộ mặc định thắng khi không bộ nào khớp rõ.</p>
              </div>
              <label className="flex min-h-9 items-center gap-2 text-sm">
                <input type="checkbox" name="autoMatch" defaultChecked={row?.autoMatch ?? true} /> cho phép tự chọn bộ này (bỏ chọn cho bộ theo mùa / tài trợ chỉ chọn tay)
              </label>
            </CollapsibleSection>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              <ColourField name="primary" label="Màu chính (nền tiêu đề)" value={brand.colours.primary} hint="Giảm độ đậm để nhìn xuyên qua thẻ tiêu đề." />
              <ColourField name="accent" label="Màu nhấn (vạch tiêu đề, thanh tiến độ)" value={brand.colours.accent} />
              <ColourField name="background" label="Màu nền (sau hình, giữa các cảnh)" value={brand.colours.background} hint="Nên để 100%: phía sau nền là màu đen." />
              <ColourField name="text" label="Màu chữ" value={brand.colours.text} />
              <ColourField name="captionBg" label="Nền phụ đề" value={brand.colours.captionBg} hint="0% = phụ đề không có nền." />
              <ColourField name="captionHighlight" label="Màu từ đang đọc" value={brand.colours.captionHighlight} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              <F name="fontHeading" label="Font tiêu đề" value={brand.fonts.heading} />
              <F name="fontBody" label="Font nội dung" value={brand.fonts.body} />
              <F name="fontCaption" label="Font phụ đề" value={brand.fonts.caption} />
            </div>
            <CollapsibleSection id="text" variant="plain" defaultOpen="desktop" title="Chữ trên video" summary={`tiêu đề ${Math.max(HEADLINE_FONT_RANGE.min, brand.headline.fontSize)} px · phụ đề ${brand.caption.fontSize} px`} summaryAlways className="rounded-lg border px-3 scroll-mt-40 [&>summary]:px-0" bodyClassName="space-y-3 pb-3">
              <div>
                <p className="text-[11px] text-muted-foreground">
                  Khung hình 1080×1920 px, gốc toạ độ ở góc trên trái. Để trống X / Y = tự động: phụ đề nằm trên vùng an toàn dưới, tiêu đề nằm ngay trên phụ đề (khoảng 1/3 từ dưới lên) để không che mặt
                  người. Xem kết quả ngay ở khung “Xem trước”.
                </p>
              </div>
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tiêu đề (headline) – thẻ chữ lớn của mỗi cảnh</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Px name="headlineFontSize" label={`Cỡ chữ tiêu đề (${HEADLINE_FONT_RANGE.min}–${HEADLINE_FONT_RANGE.max})`} min={HEADLINE_FONT_RANGE.min} max={HEADLINE_FONT_RANGE.max} value={Math.max(HEADLINE_FONT_RANGE.min, brand.headline.fontSize)} hint="Nên lớn hơn phụ đề. Tiêu đề cảnh mở đầu tự lớn hơn 22%." />
                  <Px name="headlineX" label="X: mép trái thẻ" min={0} max={1080} value={brand.headline.x} placeholder="tự động (60)" />
                  <Px name="headlineY" label="Y: mép dưới thẻ" min={0} max={1920} value={brand.headline.y} placeholder="tự động" hint="Tiêu đề dài mọc lên phía trên mốc này." />
                </div>
                <ShadowFields prefix="headlineShadow" label="Bóng đổ của thẻ tiêu đề" value={brand.headline.shadow} />
              </div>
              <div className="space-y-2 border-t pt-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Phụ đề (captions) – lời đọc chạy theo giọng</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Px name="captionFontSize" label={`Cỡ chữ phụ đề (${CAPTION_FONT_RANGE.min}–${CAPTION_FONT_RANGE.max})`} min={CAPTION_FONT_RANGE.min} max={CAPTION_FONT_RANGE.max} value={brand.caption.fontSize} />
                  <Px name="captionX" label="X: tâm khối / mép trái" min={0} max={1080} value={brand.caption.x} placeholder="tự động (480 / 60)" hint="Căn giữa: X là tâm khối. Căn trái: X là mép trái." />
                  <Px name="captionY" label="Y: mép dưới khối" min={0} max={1920} value={brand.caption.y} placeholder="tự động" hint="Có giá trị thì bỏ qua “vị trí tự động”." />
                </div>
                <ShadowFields prefix="captionShadow" label="Bóng đổ của khung phụ đề" value={brand.caption.shadow} />
              </div>
              <div className="grid gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="captionAlign">Căn lề phụ đề</Label>
                  <NativeSelect id="captionAlign" name="captionAlign" defaultValue={brand.caption.align}>
                    <option value="center">căn giữa</option>
                    <option value="left">căn trái</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="captionPosition">Vị trí phụ đề tự động</Label>
                  <NativeSelect id="captionPosition" name="captionPosition" defaultValue={brand.caption.position}>
                    <option value="bottom">dưới (trên vùng an toàn)</option>
                    <option value="middle">giữa</option>
                  </NativeSelect>
                </div>
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="captionUppercase" defaultChecked={brand.caption.uppercase} /> IN HOA
                </label>
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="captionHighlightWords" defaultChecked={brand.caption.highlightWords} /> tô từ đang đọc
                </label>
              </div>
            </CollapsibleSection>
            <div id="logo" className="grid gap-3 scroll-mt-40 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="logo">Logo xem trước / dự phòng (PNG/SVG/WebP, ≤ 2 MB)</Label>
                <Input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" />
                <div className="space-y-1 pt-2">
                  <Label htmlFor="logoMotion">Chuyển động logo trong video</Label>
                  <NativeSelect id="logoMotion" name="logoMotion" defaultValue={brand.logoMotion}>
                    <option value="flip">lật 3D như đồng xu (mỗi 6 giây)</option>
                    <option value="tilt">trôi nổi: nghiêng nhẹ liên tục</option>
                    <option value="spin">xoay tròn một vòng (hợp logo tròn)</option>
                    <option value="pulse">nhịp đập (phóng nhẹ)</option>
                    <option value="none">đứng yên</option>
                  </NativeSelect>
                  <p className="text-[11px] text-muted-foreground">Mọi kiểu đều có màn xuất hiện: logo xoay ra từ cạnh khi video bắt đầu.</p>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Bộ nhận diện dùng chung cho mọi kênh, còn logo đi theo kênh (tải lên ở mục Kênh, /app/channels, chọn khi tạo dự án và mỗi lần kết xuất). Logo ở đây dùng cho khung xem trước và khi
                  dự án không chọn kênh hoặc kênh chưa có logo.
                </p>
                {logoUrl ? (
                  <div className="flex items-center gap-3 pt-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={logoUrl} alt="logo" className="h-12 rounded bg-slate-800 p-1" />
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="removeLogo" /> xoá logo
                    </label>
                  </div>
                ) : null}
              </div>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="overlayLayer">Lớp phủ PNG nằm ở</Label>
                  <NativeSelect id="overlayLayer" name="overlayLayer" defaultValue={brand.overlayLayer}>
                    <option value="under_text">trên hình, dưới tiêu đề / phụ đề / logo</option>
                    <option value="top">trên cùng (che cả chữ)</option>
                  </NativeSelect>
                </div>
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" name="showSource" defaultChecked={brand.showSource} /> hiện nguồn ảnh / video trên từng cảnh (nguồn bài báo luôn hiện ở cuối)
                </label>
              </div>
            </div>
            <Button type="submit" disabled={!canEdit} className="w-full sm:w-auto">
              <Save /> {row ? "Lưu bộ nhận diện" : "Tạo bộ nhận diện"}
            </Button>
            {!canEdit ? <p className="text-xs text-muted-foreground">Chỉ admin/publisher của workspace mới sửa được.</p> : null}
          </ActionForm>
        </CardContent>
      </Card>

      {row ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lớp phủ PNG của “{row.name}”</CardTitle>
            <CardDescription>Khung, dải màu, hoạ tiết… phủ lên toàn bộ video; lưu ngay khi tải lên, không cần bấm Lưu ở trên.</CardDescription>
          </CardHeader>
          <CardContent>
            <OverlayUploader
              key={`${row.id}-${row.overlayPath ?? ""}`}
              kitId={row.id}
              overlayUrl={overlayUrl}
              canEdit={canEdit}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">Tạo bộ trước, rồi tải lớp phủ PNG lên ở bước sau.</p>
      )}

      {row && canEdit ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-3 shadow-xs ring-1 ring-border">
          {!row.isDefault ? (
            <ActionForm action={setDefaultBrandKit}>
              <input type="hidden" name="id" value={row.id} />
              <Button type="submit" size="sm" variant="outline">
                Đặt làm mặc định
              </Button>
            </ActionForm>
          ) : (
            <span className="text-xs text-muted-foreground">Đây là bộ mặc định: dùng khi không bộ nào khớp bài.</span>
          )}
          <ActionForm action={duplicateBrandKit}>
            <input type="hidden" name="id" value={row.id} />
            <Button type="submit" size="sm" variant="outline">
              Nhân bản
            </Button>
          </ActionForm>
          {!row.isDefault ? (
            <ActionForm action={deleteBrandKit} className="flex items-center gap-2 sm:ml-auto">
              <input type="hidden" name="id" value={row.id} />
              <label className="flex min-h-9 items-center gap-1.5 text-xs">
                <input type="checkbox" name="confirm" /> xác nhận xoá
              </label>
              <Button type="submit" size="sm" variant="ghost" className="text-destructive">
                Xoá bộ này
              </Button>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
        </div>
        <aside className="order-first lg:sticky lg:top-40 lg:order-none">
          <CollapsibleSection id="preview" title="Xem trước" defaultOpen="desktop" summary="bản mẫu, cập nhật theo biểu mẫu" className="scroll-mt-40">
            <div className="mx-auto max-w-[300px]">
              <BrandPreviewLoader key={`${row?.id ?? "new"}-${row?.updatedAt?.getTime() ?? 0}`} formId={FORM_ID} brand={brand} logoUrl={logoUrl} overlayUrl={overlayUrl} />
            </div>
          </CollapsibleSection>
        </aside>
      </div>
    </div>
  );
}
