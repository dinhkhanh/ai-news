"use client";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { SKETCH_STYLES, type SketchStyle } from "@ai-news/video/schema";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { setSceneSketch, SKETCH_LABEL, sketchCount } from "@/lib/media/editor";
import { useEditor } from "../core/context";
import { definePlugin } from "../core/plugin";
import { PanelHeader, Section, timecode } from "../shell/ui";

function LookPanel() {
  const ctx = useEditor();
  const { doc, props, readOnly } = ctx;
  // The document embeds a copy of its kit; "current" = the workspace kit that still equals that copy.
  const brandJson = JSON.stringify(doc.brand);
  const currentKit = props.brandKits.find((k) => JSON.stringify(k.brand) === brandJson) ?? null;
  const overlayOn = doc.scenes.filter((s) => s.overlay).length;
  const sketches = sketchCount(doc, ctx.derived.isAiStill);
  const cover = doc.coverAtSec;

  return (
    <div className="space-y-5 pb-4">
      <PanelHeader title="Diện mạo & âm thanh" />
      <div className="space-y-5 px-3">
        <Section title="Bộ nhận diện">
          {props.brandKits.length ? (
            <NativeSelect
              aria-label="Bộ nhận diện"
              value={currentKit?.id ?? ""}
              disabled={readOnly}
              onChange={(e) => {
                const kit = props.brandKits.find((k) => k.id === e.target.value);
                if (kit) ctx.update(`Đổi bộ nhận diện: ${kit.name}`, (d) => ({ ...d, brand: kit.brand }));
              }}
              className="w-full"
            >
              {!currentKit ? <option value="">{doc.brand.name} (bản lưu trong phiên bản này)</option> : null}
              {props.brandKits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.isDefault ? " (mặc định)" : ""}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          {!currentKit && props.brandKits.some((k) => k.name === doc.brand.name) ? <p className="text-[11px] text-muted-foreground">Bộ “{doc.brand.name}” đã được sửa sau lần dựng này; chọn lại để lấy bản mới.</p> : null}
          {doc.brand.overlaySrc ? (
            <label className="flex min-h-9 items-center justify-between gap-2 text-sm">
              <span>
                Lớp phủ PNG <span className="text-muted-foreground">· {overlayOn}/{doc.scenes.length} cảnh</span>
              </span>
              <Switch checked={overlayOn === doc.scenes.length} disabled={readOnly} onCheckedChange={(on) => ctx.update(on ? "Bật lớp phủ mọi cảnh" : "Tắt lớp phủ mọi cảnh", (d) => ({ ...d, scenes: d.scenes.map((s) => ({ ...s, overlay: on })) }))} aria-label="Lớp phủ cho mọi cảnh" />
            </label>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Bộ này chưa có lớp phủ PNG; tải lên ở{" "}
              <Link href="/app/brand" className="underline">
                Bộ nhận diện
              </Link>
              .
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {props.previewLogo ? `Logo đang xem: kênh ${props.previewLogo.channelName}. ` : "Logo đang xem: của bộ nhận diện. "}Logo đi theo kênh, chọn khi xuất. Đổi bộ chỉ đổi diện mạo; lời, hình và nhạc giữ nguyên.
          </p>
        </Section>

        {sketches.photos ? (
          <Section title="Ảnh vẽ tay · cả video" aside={<span className="text-[11px] text-muted-foreground">{sketches.drawn}/{sketches.photos} ảnh</span>}>
            <NativeSelect
              aria-label="Ảnh vẽ tay cho mọi ảnh"
              value=""
              disabled={readOnly}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const style = v === "off" ? null : (v as SketchStyle);
                ctx.update(style ? `Mọi ảnh thành tranh ${SKETCH_LABEL[style]}` : "Mọi ảnh giữ ảnh gốc", (d) => ({ ...d, scenes: d.scenes.map((s) => setSceneSketch(s, style, ctx.derived.isAiStill)) }));
              }}
              className="w-full"
              title="Mỗi ảnh mở bằng ảnh thật rồi chuyển thành tranh vẽ tay của chính nó. Ảnh AI giữ nguyên."
            >
              <option value="">Đổi cho mọi ảnh…</option>
              {SKETCH_STYLES.map((st) => (
                <option key={st} value={st}>
                  tranh {SKETCH_LABEL[st]}
                </option>
              ))}
              <option value="off">giữ ảnh gốc</option>
            </NativeSelect>
          </Section>
        ) : null}

        <Section title="Nhạc nền">
          <NativeSelect
            aria-label="Nhạc nền"
            value={doc.music?.key ?? ""}
            disabled={readOnly}
            onChange={(e) => {
              const key = e.target.value;
              if (!key) return ctx.update("Bỏ nhạc nền", (d) => ({ ...d, music: null }));
              const m = props.music.find((x) => x.key === key);
              if (m) ctx.update(`Đổi nhạc: ${m.title}`, (d) => ({ ...d, music: { key: m.key, gainDb: d.music?.gainDb ?? -12, attribution: `Nhạc: ${m.title}`, title: m.title, source: "library", licence: m.licence } }));
            }}
            className="w-full"
          >
            <option value="">— không nhạc —</option>
            {doc.music && !props.music.some((m) => m.key === doc.music!.key) ? <option value={doc.music.key}>{doc.music.title} (hiện tại)</option> : null}
            {props.music.map((m) => (
              <option key={m.id} value={m.key}>
                {m.title}
                {m.durationSec ? ` · ${m.durationSec.toFixed(0)} s` : ""}
                {m.moodTags.length ? ` · ${m.moodTags.slice(0, 3).join(", ")}` : ""}
              </option>
            ))}
          </NativeSelect>
          {doc.music ? (
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Dưới lời</span>
              <input type="range" min={-24} max={-6} step={1} value={doc.music.gainDb} disabled={readOnly} onChange={(e) => ctx.update(`Nhạc ${e.target.value} dB`, (d) => (d.music ? { ...d, music: { ...d.music, gainDb: Number(e.target.value) } } : d), { coalesce: "music.gain" })} className="flex-1 accent-primary" aria-label="Âm lượng nhạc dưới lời" />
              <span className="w-12 text-right font-mono text-muted-foreground">{doc.music.gainDb} dB</span>
            </label>
          ) : null}
          <Button size="sm" variant="outline" disabled={!ctx.canRegenerate} title={ctx.regenerateHint ?? undefined} onClick={() => ctx.services.regenerate("music")}>
            Nhạc mới (Mubert / thư viện)
          </Button>
        </Section>

        <Section title="Ảnh bìa">
          <p className="text-xs text-muted-foreground">{cover != null ? `Khung tại ${timecode(cover)}` : "Tự động (~1,2 s)"} · cờ “bìa” trên dòng thời gian; chọn nhanh ở Xuất & duyệt.</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setCoverNow(ctx)}>
              Dùng khung đang xem
            </Button>
            {cover != null ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => ctx.player.seek(cover)}>
                  xem
                </Button>
                <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => ctx.update("Ảnh bìa tự động", (d) => ({ ...d, coverAtSec: null }))}>
                  bỏ
                </Button>
              </>
            ) : null}
          </div>
        </Section>
      </div>
    </div>
  );
}

function setCoverNow(ctx: ReturnType<typeof useEditor>) {
  const sec = Math.round(ctx.player.nowSec() * 10) / 10;
  ctx.update(`Ảnh bìa tại ${sec.toFixed(1)} s`, (d) => ({ ...d, coverAtSec: sec }));
}

/** Brand kit, overlay, hand-drawn look, music and the cover frame: settings of the whole video. */
export const lookPlugin = definePlugin({
  id: "look",
  name: "Diện mạo & âm thanh",
  description: "Bộ nhận diện, lớp phủ, ảnh vẽ tay cho cả video, nhạc nền và ảnh bìa.",
  panels: [{ id: "look", title: "Diện mạo", icon: SlidersHorizontal, order: 30, Component: LookPanel }],
  markers: [{ id: "cover", items: (c) => (c.doc.coverAtSec != null ? [{ id: "cover", atSec: c.doc.coverAtSec, label: `Ảnh bìa tại ${timecode(c.doc.coverAtSec)}`, tone: "info", glyph: "bìa" }] : []) }],
  commands: [
    { id: "look.cover", title: () => "Đặt ảnh bìa tại khung đang xem", group: "Cả video", when: (c) => !c.readOnly, run: setCoverNow },
    { id: "look.music", title: () => "Tìm nhạc nền mới", group: "Cả video", when: (c) => c.canRegenerate, run: (c) => c.services.regenerate("music") },
    { id: "look.open", title: () => "Mở Diện mạo & âm thanh", group: "Đi tới", run: (c) => c.ui.setPanel("look") },
  ],
});
