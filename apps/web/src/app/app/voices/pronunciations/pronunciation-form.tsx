"use client";
import { useId } from "react";
import { Loader2, Play, Plus, Save, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PRONUNCIATION_MAX } from "@/lib/media/pronounce";
import { usePreview } from "../voice-editor";
import { savePronunciation } from "./actions";

/**
 * Listen to one field of the form in the default voice of its language: the word as the voice reads it today
 * (`term`) or the new reading (`replacement`). Reads the form's live values, so nothing has to be saved first.
 */
function Listen({ formId, field, label, icon }: { formId: string; field: "term" | "replacement"; label: string; icon: "now" | "fixed" }) {
  const { play, pending } = usePreview();
  const onClick = () => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    const value = (name: string) => ((form?.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "").trim();
    const text = value(field);
    if (!text) {
      toast.error(field === "term" ? "Nhập từ trước" : "Nhập cách đọc trước");
      return;
    }
    play({ language: value("language"), text: `${text}.` });
  };
  return (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onClick}>
      {pending ? <Loader2 className="animate-spin" /> : icon === "now" ? <Volume2 /> : <Play />} {label}
    </Button>
  );
}

/** Add a word, or (with `entry`) change how an existing one is read. */
export function PronunciationForm({ entry }: { entry?: { id: string; language: "vi" | "en"; term: string; replacement: string } }) {
  const formId = useId();
  const edit = Boolean(entry);
  const small = edit ? ({ fieldSize: "sm" } as const) : {};
  return (
    <ActionForm id={formId} action={savePronunciation} resetOnSuccess={!edit} className={edit ? "space-y-2" : "space-y-3"}>
      {entry ? <input type="hidden" name="id" value={entry.id} /> : null}
      <div className={edit ? "grid gap-2 sm:grid-cols-[7rem_1fr_1fr]" : "grid gap-3 sm:grid-cols-[8rem_1fr_1fr]"}>
        <div className="space-y-1">
          {edit ? null : <Label htmlFor={`${formId}-language`}>Ngôn ngữ</Label>}
          <NativeSelect id={`${formId}-language`} name="language" defaultValue={entry?.language ?? "vi"} className="w-full" aria-label="Ngôn ngữ" {...small}>
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          {edit ? null : <Label htmlFor={`${formId}-term`}>Từ như viết</Label>}
          <Input id={`${formId}-term`} name="term" required maxLength={PRONUNCIATION_MAX} defaultValue={entry?.term} placeholder="VnExpress" autoComplete="off" aria-label="Từ như viết" className={edit ? "h-8" : undefined} />
        </div>
        <div className="space-y-1">
          {edit ? null : <Label htmlFor={`${formId}-replacement`}>Đọc là</Label>}
          <Input id={`${formId}-replacement`} name="replacement" required maxLength={PRONUNCIATION_MAX} defaultValue={entry?.replacement} placeholder="Vi En Express" autoComplete="off" aria-label="Đọc là" className={edit ? "h-8" : undefined} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Listen formId={formId} field="term" label="Nghe hiện tại" icon="now" />
        <Listen formId={formId} field="replacement" label="Nghe cách đọc mới" icon="fixed" />
        <Button type="submit" size={edit ? "sm" : "default"} className="ml-auto">
          {edit ? <Save /> : <Plus />} {edit ? "Lưu" : "Thêm vào từ điển"}
        </Button>
      </div>
    </ActionForm>
  );
}
