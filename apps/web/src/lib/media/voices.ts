/**
 * Voices (`voice_presets`): the platform's classic Cloud TTS presets (Chirp 3 HD / Neural2, one language each) and
 * the workspace voices people create at /app/voices: a Gemini-TTS voice plus style instructions (`prompt`: tone,
 * pace, emotion…) under a name of their choice. Pure and client-safe (tested in voices.test.ts); synthesis is tts.ts.
 */

/** Gemini-TTS model of new workspace voices: GA, Vietnamese GA, `input.prompt` for style (Cloud TTS v1, global endpoint). */
export const GEMINI_TTS_MODEL = "gemini-2.5-flash-tts";

/** Gemini-TTS prebuilt voices (Cloud TTS docs, "Voice options"); each speaks every supported language. */
export const GEMINI_VOICES: ReadonlyArray<{ name: string; gender: "nam" | "nữ" }> = [
  { name: "Achernar", gender: "nữ" }, { name: "Achird", gender: "nam" }, { name: "Algenib", gender: "nam" }, { name: "Algieba", gender: "nam" },
  { name: "Alnilam", gender: "nam" }, { name: "Aoede", gender: "nữ" }, { name: "Autonoe", gender: "nữ" }, { name: "Callirrhoe", gender: "nữ" },
  { name: "Charon", gender: "nam" }, { name: "Despina", gender: "nữ" }, { name: "Enceladus", gender: "nam" }, { name: "Erinome", gender: "nữ" },
  { name: "Fenrir", gender: "nam" }, { name: "Gacrux", gender: "nữ" }, { name: "Iapetus", gender: "nam" }, { name: "Kore", gender: "nữ" },
  { name: "Laomedeia", gender: "nữ" }, { name: "Leda", gender: "nữ" }, { name: "Orus", gender: "nam" }, { name: "Pulcherrima", gender: "nữ" },
  { name: "Puck", gender: "nam" }, { name: "Rasalgethi", gender: "nam" }, { name: "Sadachbia", gender: "nam" }, { name: "Sadaltager", gender: "nam" },
  { name: "Schedar", gender: "nam" }, { name: "Sulafat", gender: "nữ" }, { name: "Umbriel", gender: "nam" }, { name: "Vindemiatrix", gender: "nữ" },
  { name: "Zephyr", gender: "nữ" }, { name: "Zubenelgenubi", gender: "nam" },
];

export const isGeminiVoice = (name: string) => GEMINI_VOICES.some((v) => v.name === name);

/** Longest style prompt kept (Gemini-TTS allows 4,000 bytes for the prompt; Vietnamese letters take 2–3 bytes). */
export const VOICE_PROMPT_MAX = 1000;

/** Starting point for a new voice's style prompt. */
export const DEFAULT_VOICE_PROMPT: Record<"vi" | "en", string> = {
  vi: "Bạn là người dẫn tin tức trên mạng xã hội. Đọc nhanh, dứt khoát, giọng tràn năng lượng, nhấn vào con số và tên riêng, không kéo dài cuối câu.",
  en: "You are a social media news presenter. Read fast and crisp, full of energy, stress the figures and names, never drag out the end of a sentence.",
};

/** What "Nghe thử" reads when the form's sample box is empty. */
export const SAMPLE_TEXT: Record<"vi" | "en", string> = {
  vi: "Tin nóng chiều nay: giá vàng tăng thêm hai triệu đồng một lượng, cao nhất từ đầu năm. Người dân xếp hàng từ sáng sớm.",
  en: "Breaking this afternoon: gold jumped two percent to its highest level this year, and buyers were queuing before the shops opened.",
};

export type VoiceRow = { id: string; organizationId: string | null; language: "vi" | "en"; model: string | null; isDefault: boolean };

/** A Gemini-TTS voice speaks any language; a classic voice only its own. */
export const voiceFits = (v: Pick<VoiceRow, "language" | "model">, language: "vi" | "en") => Boolean(v.model) || v.language === language;

/**
 * The voice a build uses: the project's choice when it can speak the story's language, else the workspace default
 * for that language, else the platform default, else any voice of that language. Null only when there is none.
 */
export function pickVoice<T extends VoiceRow>(rows: T[], language: "vi" | "en", chosenId: string | null | undefined, organizationId: string): T | null {
  const chosen = chosenId ? rows.find((r) => r.id === chosenId && (r.organizationId === null || r.organizationId === organizationId)) : undefined;
  if (chosen && voiceFits(chosen, language)) return chosen;
  return (
    rows.find((r) => r.organizationId === organizationId && r.isDefault && voiceFits(r, language)) ??
    rows.find((r) => r.organizationId === null && r.isDefault && r.language === language) ??
    rows.find((r) => r.language === language) ??
    null
  );
}

/**
 * USD of one synthesis. Gemini 2.5 Flash TTS bills tokens: $0.50 / 1M text tokens (~4 characters each, prompt
 * included) and $10 / 1M audio tokens at 25 tokens per second. Classic voices bill characters: Chirp 3 HD $30 / 1M,
 * Neural2 / Studio $16 / 1M, Standard $4 / 1M.
 */
export function ttsCostUsd(input: { voice: string; model: string | null; chars: number; promptChars?: number; durationMs: number }) {
  if (input.model) return ((input.chars + (input.promptChars ?? 0)) / 4) * (0.5 / 1e6) + (input.durationMs / 1000) * 25 * (10 / 1e6);
  const perMillion = input.voice.includes("Chirp") ? 30 : input.voice.includes("Neural2") || input.voice.includes("Studio") ? 16 : 4;
  return input.chars * (perMillion / 1e6);
}
