"use client";
import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Play, Save } from "lucide-react";
import { toast } from "sonner";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_VOICE_PROMPT, GEMINI_VOICES, SAMPLE_TEXT, VOICE_PROMPT_MAX } from "@/lib/media/voices";
import { previewVoice, saveVoice, type VoiceSample } from "./actions";

/** Plays one sample at a time; a new sample stops the previous one. */
export function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [pending, start] = useTransition();
  const play = (input: Parameters<typeof previewVoice>[0]) =>
    start(async () => {
      const r: VoiceSample = await previewVoice(input);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      audio.current?.pause();
      audio.current = new Audio(r.audio);
      await audio.current.play().catch(() => toast.error("The browser blocked playback; press again"));
    });
  return { play, pending };
}

/** "Nghe thử" for a saved voice (platform or workspace), in the language of the list it sits in. */
export function VoicePreviewButton({ presetId, language }: { presetId: string; language: "vi" | "en" }) {
  const { play, pending } = usePreview();
  return (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => play({ presetId, language })} aria-label="Nghe thử">
      {pending ? <Loader2 className="animate-spin" /> : <Play />} Nghe thử
    </Button>
  );
}

export type VoiceDraft = { id: string | null; name: string; language: "vi" | "en"; voice: string; prompt: string; isDefault: boolean };

/**
 * Create / edit a workspace voice: pick a Gemini-TTS voice, write how it should read (tone, pace, emotion…), listen,
 * save under a name. The sample reads the form's current values, so nothing has to be saved to try it.
 */
export function VoiceEditor({ initial }: { initial: VoiceDraft }) {
  const [language, setLanguage] = useState(initial.language);
  const [voice, setVoice] = useState(initial.voice);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [sample, setSample] = useState("");
  const { play, pending } = usePreview();

  return (
    <ActionForm action={saveVoice} className="space-y-3" resetOnSuccess={!initial.id}>
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="space-y-1">
          <Label htmlFor="voice-name">Tên giọng</Label>
          <Input id="voice-name" name="name" required maxLength={80} defaultValue={initial.name} placeholder="Ví dụ: Dẫn tin dồn dập nữ" autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="voice-language">Ngôn ngữ chính</Label>
          <NativeSelect id="voice-language" name="language" value={language} onChange={(e) => setLanguage(e.target.value === "en" ? "en" : "vi")} className="w-full" title="Giọng Gemini đọc được cả hai ngôn ngữ; đây là ngôn ngữ nó làm mặc định và để nghe thử.">
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="voice-voice">Giọng</Label>
          <NativeSelect id="voice-voice" name="voice" value={voice} onChange={(e) => setVoice(e.target.value)} className="w-full">
            {GEMINI_VOICES.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} · {v.gender}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="voice-prompt">Cách đọc (giọng điệu, tốc độ, cảm xúc…)</Label>
          <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setPrompt(DEFAULT_VOICE_PROMPT[language])}>
            dùng mẫu
          </button>
        </div>
        <Textarea
          id="voice-prompt"
          name="prompt"
          rows={4}
          maxLength={VOICE_PROMPT_MAX}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={DEFAULT_VOICE_PROMPT[language]}
          className="text-sm leading-relaxed"
        />
        <p className="text-xs text-muted-foreground">
          {prompt.length}/{VOICE_PROMPT_MAX}. Viết như dặn người đọc: “đọc nhanh, dứt khoát”, “giọng trầm, chậm rãi, nghiêm túc”, “hào hứng như bình luận thể thao”…
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="voice-sample">Câu nghe thử (không bắt buộc)</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="voice-sample" value={sample} onChange={(e) => setSample(e.target.value)} placeholder={SAMPLE_TEXT[language]} autoComplete="off" className="flex-1" />
          <Button type="button" variant="outline" disabled={pending} onClick={() => play({ voice, prompt, language, text: sample })} className="sm:shrink-0">
            {pending ? <Loader2 className="animate-spin" /> : <Play />} Nghe thử
          </Button>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="isDefault" defaultChecked={initial.isDefault} /> giọng mặc định của workspace cho ngôn ngữ này
        </label>
        <div className="flex gap-2">
          {initial.id ? (
            <Button variant="ghost" render={<Link href="/app/voices" />}>
              Huỷ
            </Button>
          ) : null}
          <Button type="submit">
            <Save /> {initial.id ? "Lưu giọng" : "Tạo giọng"}
          </Button>
        </div>
      </div>
    </ActionForm>
  );
}
