import Link from "next/link";
import { asc, desc, eq, isNull, or } from "drizzle-orm";
import { Pencil, Star, Trash2 } from "lucide-react";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DEFAULT_VOICE_PROMPT } from "@/lib/media/voices";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { deleteVoice, setDefaultVoice } from "./actions";
import { VoiceTabs } from "./voice-tabs";
import { VoiceEditor, VoicePreviewButton, type VoiceDraft } from "./voice-editor";

export const dynamic = "force-dynamic";

const LANG_LABEL = { vi: "Tiếng Việt", en: "English" } as const;

/**
 * Voices: the workspace's own (a Gemini-TTS voice + how it should read, under a name, created by anyone who edits
 * projects) and the platform presets. Projects pick one at creation or in the build form; none = the default.
 */
export default async function VoicesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const ws = await requireWorkspace();
  const writer = canWrite(ws);
  const sp = await searchParams;
  const rows = await withOrgContext(ws, (tx) =>
    tx
      .select({
        id: schema.voicePresets.id,
        organizationId: schema.voicePresets.organizationId,
        name: schema.voicePresets.name,
        language: schema.voicePresets.language,
        voice: schema.voicePresets.voice,
        model: schema.voicePresets.model,
        prompt: schema.voicePresets.prompt,
        rate: schema.voicePresets.rate,
        isDefault: schema.voicePresets.isDefault,
        createdByName: schema.user.name,
      })
      .from(schema.voicePresets)
      .leftJoin(schema.user, eq(schema.user.id, schema.voicePresets.createdBy))
      .where(or(eq(schema.voicePresets.organizationId, ws.organizationId), isNull(schema.voicePresets.organizationId)))
      .orderBy(asc(schema.voicePresets.language), desc(schema.voicePresets.isDefault), asc(schema.voicePresets.name)),
  );
  const mine = rows.filter((r) => r.organizationId);
  const platform = rows.filter((r) => !r.organizationId);
  const editing = sp.edit ? mine.find((r) => r.id === sp.edit) : undefined;
  const draft: VoiceDraft = editing
    ? { id: editing.id, name: editing.name, language: editing.language, voice: editing.voice, prompt: editing.prompt ?? "", isDefault: editing.isDefault }
    : { id: null, name: "", language: "vi", voice: "Kore", prompt: DEFAULT_VOICE_PROMPT.vi, isDefault: false };
  // What a project without a chosen voice gets, per language.
  const effectiveDefault = (lang: "vi" | "en") => mine.find((r) => r.isDefault && r.language === lang) ?? platform.find((r) => r.isDefault && r.language === lang);

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-6">
      <VoiceTabs active="voices" />
      <p className="text-sm text-muted-foreground">
        Giọng mặc định: {LANG_LABEL.vi} · {effectiveDefault("vi")?.name ?? "—"} — {LANG_LABEL.en} · {effectiveDefault("en")?.name ?? "—"}. Dự án không chọn giọng sẽ dùng giọng mặc định.
      </p>

      {writer ? (
        <Card id="editor">
          <CardHeader>
            <CardTitle>{editing ? `Sửa giọng “${editing.name}”` : "Giọng mới"}</CardTitle>
            <CardDescription>
              Chọn giọng, dặn cách đọc (giọng điệu, tốc độ, cảm xúc), nghe thử rồi lưu với tên dễ nhớ. Khi tạo dự án, chọn giọng này trong «Tuỳ chọn». Giọng Gemini đọc được cả tiếng Việt lẫn tiếng Anh.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VoiceEditor key={draft.id ?? "new"} initial={draft} />
          </CardContent>
        </Card>
      ) : null}

      <section aria-labelledby="mine-heading" className="space-y-2">
        <h2 id="mine-heading" className="px-1 text-sm font-medium text-muted-foreground">
          Giọng của workspace · {mine.length}
        </h2>
        {mine.length === 0 ? (
          <p className="rounded-xl bg-card p-6 text-center text-sm text-muted-foreground shadow-xs ring-1 ring-border">Chưa có giọng nào. Tạo giọng đầu tiên ở trên.</p>
        ) : (
          <ul className="divide-y rounded-xl bg-card shadow-xs ring-1 ring-border">
            {mine.map((v) => (
              <li key={v.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4 sm:px-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{v.name}</span>
                    {v.isDefault ? <Badge variant="success">mặc định {LANG_LABEL[v.language]}</Badge> : null}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {v.voice} · {LANG_LABEL[v.language]}
                    {v.createdByName ? ` · tạo bởi ${v.createdByName}` : ""}
                  </div>
                  {v.prompt ? <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{v.prompt}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <VoicePreviewButton presetId={v.id} language={v.language} />
                  {writer ? (
                    <>
                      <Button size="sm" variant="outline" render={<Link href={`/app/voices?edit=${v.id}#editor`} />}>
                        <Pencil /> Sửa
                      </Button>
                      <ActionForm action={setDefaultVoice}>
                        <input type="hidden" name="id" value={v.id} />
                        <input type="hidden" name="on" value={v.isDefault ? "0" : "1"} />
                        <Button type="submit" size="sm" variant="outline" title={v.isDefault ? "Bỏ mặc định: dùng lại giọng mặc định của hệ thống" : `Dùng cho mọi dự án ${LANG_LABEL[v.language]} không chọn giọng`}>
                          <Star /> {v.isDefault ? "Bỏ mặc định" : "Đặt mặc định"}
                        </Button>
                      </ActionForm>
                      <ActionForm action={deleteVoice}>
                        <input type="hidden" name="id" value={v.id} />
                        <Button type="submit" size="icon-sm" variant="ghost" className="text-destructive" aria-label={`Xoá giọng ${v.name}`} title="Xoá: dự án đang chọn giọng này sẽ dùng giọng mặc định; video đã dựng giữ nguyên.">
                          <Trash2 />
                        </Button>
                      </ActionForm>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="platform-heading" className="space-y-2">
        <h2 id="platform-heading" className="px-1 text-sm font-medium text-muted-foreground">
          Giọng có sẵn · {platform.length}
        </h2>
        <ul className="divide-y rounded-xl bg-card shadow-xs ring-1 ring-border">
          {platform.map((v) => (
            <li key={v.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{v.name}</span>
                  {v.isDefault ? <Badge variant="outline">mặc định hệ thống</Badge> : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {v.voice} · {LANG_LABEL[v.language]} · tốc độ {Number(v.rate).toFixed(2)}× · chỉ đọc {LANG_LABEL[v.language]}
                </div>
              </div>
              <VoicePreviewButton presetId={v.id} language={v.language} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
