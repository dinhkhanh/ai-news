import { and, eq } from "drizzle-orm";
import { BRAND_FONTS } from "@ai-news/video/schema";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brandFromRow } from "@/lib/media/brand";
import { presignGet } from "@/lib/r2";
import { requireWorkspace } from "@/lib/workspace";
import { saveBrandKit } from "./actions";

export const dynamic = "force-dynamic";

function C({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <div className="flex items-center gap-2">
        <span className="h-9 w-9 shrink-0 rounded border" style={{ background: value }} aria-hidden />
        <Input id={name} name={name} defaultValue={value} className="w-32 font-mono" />
      </div>
    </div>
  );
}

function F({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={name}>{label}</Label>
      <select id={name} name={name} defaultValue={value} className="h-9 rounded-md border bg-background px-2 text-sm">
        {BRAND_FONTS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </div>
  );
}

export default async function BrandPage() {
  const ws = await requireWorkspace();
  const row = await withOrgContext(ws, (tx) => tx.query.brandKits.findFirst({ where: and(eq(schema.brandKits.organizationId, ws.organizationId), eq(schema.brandKits.isDefault, true)) }));
  const { brand } = brandFromRow(row);
  const canEdit = ws.isAdmin || ["admin", "owner", "publisher"].includes(ws.role);
  let logoUrl: string | null = null;
  if (row?.logoPath) {
    try {
      logoUrl = await presignGet(row.logoPath, 600);
    } catch {
      logoUrl = null;
    }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bộ nhận diện</h1>
        <p className="text-sm text-muted-foreground">Workspace {ws.name}. Áp dụng cho các lần dựng timeline tiếp theo: màu, font (hỗ trợ tiếng Việt), logo, kiểu phụ đề, dòng nguồn.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{row ? row.name : "Chưa có bộ nhận diện riêng (đang dùng mặc định)"}</CardTitle>
          <CardDescription>Vùng an toàn cố định cho 1080×1920: trên 220 px, dưới 420 px, trái 60 px, phải 180 px.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveBrandKit} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="name">Tên</Label>
                <Input id="name" name="name" defaultValue={row?.name ?? "Brand kit"} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="outroText">Dòng kết (outro)</Label>
                <Input id="outroText" name="outroText" defaultValue={brand.outroText ?? ""} placeholder="Theo dõi để cập nhật tin mới" />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <C name="primary" label="Màu chính (nền tiêu đề)" value={brand.colours.primary} />
              <C name="accent" label="Màu nhấn" value={brand.colours.accent} />
              <C name="background" label="Màu nền" value={brand.colours.background} />
              <C name="text" label="Màu chữ" value={brand.colours.text} />
              <C name="captionHighlight" label="Màu từ đang đọc" value={brand.colours.captionHighlight} />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <F name="fontHeading" label="Font tiêu đề" value={brand.fonts.heading} />
              <F name="fontBody" label="Font nội dung" value={brand.fonts.body} />
              <F name="fontCaption" label="Font phụ đề" value={brand.fonts.caption} />
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="captionPosition">Vị trí phụ đề</Label>
                <select id="captionPosition" name="captionPosition" defaultValue={brand.caption.position} className="h-9 rounded-md border bg-background px-2 text-sm">
                  <option value="bottom">dưới (trên vùng an toàn)</option>
                  <option value="middle">giữa</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="captionFontSize">Cỡ phụ đề (36–96)</Label>
                <Input id="captionFontSize" name="captionFontSize" type="number" min={36} max={96} defaultValue={brand.caption.fontSize} />
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" name="captionUppercase" defaultChecked={brand.caption.uppercase} /> IN HOA
              </label>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" name="captionHighlightWords" defaultChecked={brand.caption.highlightWords} /> tô từ đang đọc
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="logo">Logo (PNG/SVG/WebP, ≤ 2 MB)</Label>
                <Input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" />
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
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" name="showSource" defaultChecked={brand.showSource} /> hiện dòng “Nguồn: …”
              </label>
            </div>
            <Button type="submit" disabled={!canEdit}>
              Lưu bộ nhận diện
            </Button>
            {!canEdit ? <p className="text-xs text-muted-foreground">Chỉ admin/publisher của workspace mới sửa được.</p> : null}
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
