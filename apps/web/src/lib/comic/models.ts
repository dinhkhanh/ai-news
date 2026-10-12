/**
 * Model catalogue of the comic studio (docs/COMIC.md §5). Pure, shared by the form, the estimate and the jobs.
 * Prices are what `usage_costs` records; check them against the providers' price pages when a model changes.
 */

export type TextModel = { id: string; label: string; note: string; inputUsd: number; outputUsd: number; serverFallback: boolean };

/** Writes the adaptation. Same Anthropic client as the news scripts (Vault key, monthly spend cap). */
export const TEXT_MODELS: readonly TextModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "mặc định · dựng truyện tốt nhất", inputUsd: 4, outputUsd: 20, serverFallback: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "nhanh hơn · nửa giá", inputUsd: 2, outputUsd: 10, serverFallback: true },
  // Claude Haiku 5.5 has no server-side refusal fallback.
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "bản nháp", inputUsd: 0.1, outputUsd: 0.5, serverFallback: false },
];
export const DEFAULT_TEXT_MODEL = TEXT_MODELS[0].id;

export type ImageProvider = "vertex" | "openai";

export type ImageModel = {
  id: string;
  label: string;
  note: string;
  /** Who draws it: Gemini on Vertex (`google_veo` integration) or GPT Image on OpenAI (`openai` integration). */
  provider: ImageProvider;
  /** The provider's model id (Vertex `generateContent` model, OpenAI `model`). */
  apiId: string;
  /** Vertex output resolution. */
  imageSize?: "1K" | "2K";
  /** OpenAI rendering quality. */
  quality?: "low" | "medium" | "high";
  /** Output image cost (USD), what the estimate uses; OpenAI drawings are then billed from the tokens they report. */
  usdPerImage: number;
  /** Rough cost of one reference image sent with the prompt (input image tokens). */
  usdPerRef: number;
  /** Input (prompt + reference image) tokens, USD per million; OpenAI: the prompt's text tokens. */
  inputUsdPerMTok: number;
  /** OpenAI: input image tokens and output image tokens, USD per million. */
  imageInputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
  /** Reference images sent with one request at most (sheets, setting, style, previous panel). */
  maxRefs: number;
  aspectRatios: readonly string[];
};

const GEMINI_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

/** Vertex Gemini (docs/COMIC.md §5) and, from M3, GPT Image on OpenAI. */
export const IMAGE_MODELS: readonly ImageModel[] = [
  {
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    note: "mặc định · nhanh, rẻ",
    provider: "vertex",
    apiId: "gemini-3.1-flash-image",
    imageSize: "1K",
    // 1120 output-image tokens at $60 / 1M (the rate media/generate.ts records).
    usdPerImage: 0.0672,
    usdPerRef: 0.0003,
    inputUsdPerMTok: 0.5,
    maxRefs: 4,
    aspectRatios: GEMINI_RATIOS,
  },
  {
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    note: "giữ nét nhân vật tốt hơn · gấp đôi giá",
    provider: "vertex",
    // Preview id on Vertex at the time of writing; switch to the GA id when Google publishes it.
    apiId: "gemini-3-pro-image-preview",
    imageSize: "2K",
    usdPerImage: 0.134,
    usdPerRef: 0.0011,
    inputUsdPerMTok: 2,
    maxRefs: 8,
    aspectRatios: GEMINI_RATIOS,
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2 (OpenAI)",
    note: "bám chỉ dẫn và chữ tốt · tính theo token",
    provider: "openai",
    apiId: "gpt-image-2",
    quality: "medium",
    // Estimate only (≈ 1 600 output tokens of a 1.5 MP picture at medium quality); `usage_costs` records the tokens.
    usdPerImage: 0.05,
    usdPerRef: 0.006,
    inputUsdPerMTok: 5,
    imageInputUsdPerMTok: 8,
    outputUsdPerMTok: 30,
    maxRefs: 8,
    aspectRatios: GEMINI_RATIOS,
  },
];
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].id;

export const textModel = (id: string | null | undefined) => TEXT_MODELS.find((m) => m.id === id) ?? TEXT_MODELS[0];
export const imageModel = (id: string | null | undefined) => IMAGE_MODELS.find((m) => m.id === id) ?? IMAGE_MODELS[0];
export const isTextModel = (id: string) => TEXT_MODELS.some((m) => m.id === id);
export const isImageModel = (id: string) => IMAGE_MODELS.some((m) => m.id === id);

/** Rough adaptation cost: the whole story in (≈ 3.5 chars per token plus the instructions), the script out. */
export function estimateAdaptUsd(modelId: string, storyChars: number, pages = 8) {
  const m = textModel(modelId);
  const input = storyChars / 3.5 + 2500;
  const output = 900 * pages + 1500;
  return (input * m.inputUsd + output * m.outputUsd) / 1_000_000;
}

/** Drawing cost of `images` pictures with about `refsEach` references each. */
export function estimateDrawUsd(modelId: string, images: number, refsEach = 3) {
  const m = imageModel(modelId);
  return images * (m.usdPerImage + Math.min(refsEach, m.maxRefs) * m.usdPerRef);
}

/** What one Vertex drawing cost, from the tokens Vertex reports for the prompt and references. */
export const imageCostUsd = (modelId: string, promptTokens: number) => {
  const m = imageModel(modelId);
  return m.usdPerImage + (promptTokens * m.inputUsdPerMTok) / 1_000_000;
};

export type OpenAiImageUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };

/** What one OpenAI drawing cost, from its `usage` (text in, image in, image out); the estimate when it sent none. */
export function openaiImageCostUsd(modelId: string, usage: OpenAiImageUsage | null | undefined, refs: number) {
  const m = imageModel(modelId);
  if (!usage?.output_tokens) return m.usdPerImage + refs * m.usdPerRef;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const textIn = usage.input_tokens_details?.text_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - imageIn);
  return (textIn * m.inputUsdPerMTok + imageIn * (m.imageInputUsdPerMTok ?? m.inputUsdPerMTok) + usage.output_tokens * (m.outputUsdPerMTok ?? 0)) / 1_000_000;
}

const STANDARD_SIZES: Record<string, string> = { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024" };

/**
 * OpenAI `size` for an aspect ratio: the standard sizes where one fits, otherwise about 1.5 MP with both edges a
 * multiple of 16 (GPT Image 2 custom sizes: ratio within 1:3–3:1, longest edge ≤ 3 840, 655 360–8 294 400 pixels).
 */
export function openaiSize(ratio: string) {
  if (STANDARD_SIZES[ratio]) return STANDARD_SIZES[ratio];
  const [a, b] = ratio.split(":").map(Number);
  const r = Math.min(3, Math.max(1 / 3, a > 0 && b > 0 ? a / b : 1));
  const pixels = 1024 * 1536;
  const w = Math.round(Math.sqrt(pixels * r) / 16) * 16;
  const h = Math.round(Math.sqrt(pixels / r) / 16) * 16;
  return `${Math.min(3840, w)}x${Math.min(3840, h)}`;
}

export const formatUsd = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`;
