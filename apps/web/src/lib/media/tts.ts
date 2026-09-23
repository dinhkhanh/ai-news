import "server-only";
import { SpeechClient, protos as speechProtos } from "@google-cloud/speech";
import textToSpeech, { protos as ttsProtos } from "@google-cloud/text-to-speech";
import { and, eq, isNull, or } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { recordUsageCost } from "@/lib/activity";
import { putObject } from "@/lib/r2";
import { alignWords, readTwice, type AlignResult, type SttWord, type TimedWord } from "./align";
import { GOOGLE_LANG, googleCredentials } from "./google";
import { displayTimedWords, pronounce, splitWords, ssmlEscape } from "./pronounce";
import { pickVoice, ttsCostUsd } from "./voices";

/**
 * Voice-over synthesis (docs/PLAN.md §4.4): Google Cloud TTS with the workspace
 * voice preset and pronunciation dictionary. Word timings come from SSML marks
 * on Neural2 voices and from Speech-to-Text alignment on Chirp 3 HD and
 * Gemini-TTS voices (a workspace voice: `model` + style `prompt`, media/voices.ts).
 * Audio is LINEAR16 24 kHz WAV so STT and the media Lambda get lossless input.
 */
const SAMPLE_RATE = 24_000;
/** STT v1 standard model, billed per 15 s increment. */
const STT_PRICE_PER_MIN = 0.024;
/** Gemini-TTS takes per scene when a take reads the text twice (`readTwice`). */
const GEMINI_TAKES = 3;

export type VoicePreset = { id: string; name: string; voice: string; language: "vi" | "en"; rate: number; pitch: number; ssmlSupported: boolean; model: string | null; prompt: string | null };

let ttsV1: InstanceType<typeof textToSpeech.TextToSpeechClient> | undefined;
let ttsBeta: InstanceType<typeof textToSpeech.v1beta1.TextToSpeechClient> | undefined;
let stt: SpeechClient | undefined;

function clients() {
  const creds = googleCredentials();
  ttsV1 ??= new textToSpeech.TextToSpeechClient(creds);
  ttsBeta ??= new textToSpeech.v1beta1.TextToSpeechClient(creds);
  stt ??= new SpeechClient(creds);
  return { ttsV1, ttsBeta, stt };
}

/**
 * The voice of a build (`pickVoice`): the project's voice (`projects.voice_preset_id`) when it can speak `language`,
 * else the workspace default, else the platform default for the language.
 */
export async function loadVoicePreset(ctx: { userId: string; organizationId: string }, language: "vi" | "en", presetId?: string | null): Promise<VoicePreset> {
  const rows = await withOrgContext(ctx, (tx) =>
    tx.query.voicePresets.findMany({ where: or(eq(schema.voicePresets.organizationId, ctx.organizationId), isNull(schema.voicePresets.organizationId)) }),
  );
  const pick = pickVoice(rows, language, presetId, ctx.organizationId);
  if (!pick) throw new Error(`No voice preset for ${language}`);
  return toPreset(pick, language);
}

export type VoiceOption = { id: string; name: string; language: "vi" | "en"; model: string | null; isDefault: boolean; workspace: boolean };

/** Voices a project can pick (select options): the workspace's first, then the platform's. */
export async function listVoiceOptions(ctx: { userId: string; organizationId: string }): Promise<VoiceOption[]> {
  const rows = await withOrgContext(ctx, (tx) =>
    tx.query.voicePresets.findMany({ where: or(eq(schema.voicePresets.organizationId, ctx.organizationId), isNull(schema.voicePresets.organizationId)) }),
  );
  return rows
    .map((r) => ({ id: r.id, name: r.name, language: r.language, model: r.model, isDefault: r.isDefault, workspace: r.organizationId !== null }))
    .sort((a, b) => Number(b.workspace) - Number(a.workspace) || a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
}

/** A voice a project of this workspace may pick (its own or the platform's); null for "" (the default). Throws for anything else. */
export async function findVoice(ctx: { userId: string; organizationId: string }, id: string) {
  if (!id) return null;
  const row = await withOrgContext(ctx, (tx) =>
    tx.query.voicePresets.findFirst({ where: and(eq(schema.voicePresets.id, id), or(eq(schema.voicePresets.organizationId, ctx.organizationId), isNull(schema.voicePresets.organizationId))), columns: { id: true, name: true } }),
  );
  if (!row) throw new Error("That voice no longer exists");
  return row;
}

export function toPreset(row: typeof schema.voicePresets.$inferSelect, language: "vi" | "en"): VoicePreset {
  return { id: row.id, name: row.name, voice: row.voice, language, rate: Number(row.rate), pitch: Number(row.pitch), ssmlSupported: row.ssmlSupported, model: row.model, prompt: row.prompt };
}

export async function loadPronunciations(ctx: { userId: string; organizationId: string }, language: "vi" | "en") {
  const rows = await withOrgContext(ctx, (tx) =>
    tx.query.pronunciations.findMany({
      where: and(eq(schema.pronunciations.language, language), or(eq(schema.pronunciations.organizationId, ctx.organizationId), isNull(schema.pronunciations.organizationId))),
    }),
  );
  // Workspace entries override platform entries for the same term.
  const byTerm = new Map<string, { term: string; replacement: string }>();
  for (const r of rows.sort((a, b) => (a.organizationId ? 1 : 0) - (b.organizationId ? 1 : 0))) byTerm.set(r.term, { term: r.term, replacement: r.replacement });
  return [...byTerm.values()];
}

const secondsToMs = (t: { seconds?: unknown; nanos?: number | null } | null | undefined) => Math.round(Number(String(t?.seconds ?? 0)) * 1000 + (t?.nanos ?? 0) / 1e6);

export function wavDurationMs(wav: Uint8Array) {
  // LINEAR16 mono from Google: 44-byte RIFF header, 16-bit samples.
  return Math.round(((wav.byteLength - 44) / (SAMPLE_RATE * 2)) * 1000);
}

export type SceneVoice = {
  sceneId: string;
  key: string;
  durationMs: number;
  words: TimedWord[];
  timing: AlignResult["method"] | "ssml";
  matched: number;
  chars: number;
  spokenText: string;
  pronunciationsApplied: string[];
  costUsd: number;
};

/**
 * Synthesise one scene, upload the WAV to R2 and return word timings relative
 * to the start of that scene's audio.
 */
export async function synthesizeScene(
  input: { sceneId: string; text: string; language: "vi" | "en"; preset: VoicePreset; pronunciations: Array<{ term: string; replacement: string }>; r2Key: string },
  ctx: { userId: string; organizationId: string; projectId: string },
): Promise<SceneVoice> {
  const { ttsV1, ttsBeta } = clients();
  // The dictionary is for the ear: the TTS reads `spoken`, the caption words are folded back to the text as written.
  const { spoken, applied, groups } = pronounce(input.text, input.pronunciations);
  const words = splitWords(spoken);
  const languageCode = GOOGLE_LANG[input.language];
  const isChirp = input.preset.voice.includes("Chirp");
  const gemini = Boolean(input.preset.model);
  const audioConfig = {
    audioEncoding: ttsProtos.google.cloud.texttospeech.v1.AudioEncoding.LINEAR16,
    sampleRateHertz: SAMPLE_RATE,
    speakingRate: input.preset.rate,
    ...(isChirp ? {} : { pitch: input.preset.pitch }),
  };
  const voice = { languageCode, name: input.preset.voice };

  let audio: Uint8Array;
  let timed: TimedWord[] | null = null;
  let timing: SceneVoice["timing"] = "proportional";
  let matched = 0;
  let heard: SttWord[] | null = null;
  let sttCost = 0;
  const transcribe = async (wav: Uint8Array) => {
    const ms = wavDurationMs(wav);
    const out = await transcribeWords(wav, languageCode);
    const cost = (Math.ceil(ms / 15_000) * 15 / 60) * STT_PRICE_PER_MIN;
    sttCost += cost;
    await recordUsageCost({ provider: "google_stt", resource: "latest_long", units: ms / 1000, unitType: "seconds", costUsd: cost, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { sceneId: input.sceneId } });
    return out;
  };
  let ttsCost = 0;
  const recordTts = async (wav: Uint8Array, meta: Record<string, unknown> = {}) => {
    const ms = wavDurationMs(wav);
    const cost = ttsCostUsd({ voice: input.preset.voice, model: input.preset.model, chars: spoken.length, promptChars: input.preset.prompt?.length ?? 0, durationMs: ms });
    ttsCost += cost;
    await recordUsageCost({ provider: "google_tts", resource: input.preset.model ? `${input.preset.model}:${input.preset.voice}` : input.preset.voice, units: spoken.length, unitType: "characters", costUsd: cost, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { sceneId: input.sceneId, durationMs: ms, voicePreset: input.preset.id, ...meta } });
  };

  if (gemini) {
    // Gemini-TTS: the style prompt steers tone and pace; no timepoints, so STT aligns the words below. It sometimes reads a
    // short text twice in one take: the transcript shows it, so that take is synthesised again (3 takes at most).
    audio = new Uint8Array();
    for (let take = 1; take <= GEMINI_TAKES; take++) {
      audio = await geminiSpeech(spoken, languageCode, input.preset);
      await recordTts(audio, { take });
      try {
        heard = await transcribe(audio);
      } catch (e) {
        console.warn("[tts] STT failed on a Gemini take", e);
        heard = null;
        break;
      }
      if (!readTwice(words, heard)) break;
      console.warn(`[tts] ${input.sceneId}: Gemini read the text twice (take ${take}/${GEMINI_TAKES})`);
    }
  } else if (input.preset.ssmlSupported && !isChirp) {
    // Neural2/Studio: SSML marks before every word → exact start times from the engine.
    const ssml = `<speak>${words.map((w, i) => `<mark name="w${i}"/>${ssmlEscape(w)}`).join(" ")}</speak>`;
    const [res] = await ttsBeta.synthesizeSpeech({
      input: { ssml },
      voice,
      audioConfig: { ...audioConfig, audioEncoding: ttsProtos.google.cloud.texttospeech.v1beta1.AudioEncoding.LINEAR16 },
      enableTimePointing: [ttsProtos.google.cloud.texttospeech.v1beta1.SynthesizeSpeechRequest.TimepointType.SSML_MARK],
    });
    audio = res.audioContent as Uint8Array;
    const durationMs = wavDurationMs(audio);
    const marks = new Map((res.timepoints ?? []).map((t) => [t.markName ?? "", Math.round((t.timeSeconds ?? 0) * 1000)]));
    if (marks.size >= Math.ceil(words.length * 0.8)) {
      timed = words.map((w, i) => {
        const s = marks.get(`w${i}`) ?? (i > 0 ? (marks.get(`w${i - 1}`) ?? 0) + 200 : 0);
        const next = marks.get(`w${i + 1}`);
        return { w, s, e: Math.min(durationMs, next !== undefined ? next : durationMs) };
      });
      timing = "ssml";
      matched = marks.size;
    }
  } else {
    const [res] = await ttsV1.synthesizeSpeech({ input: { text: spoken }, voice, audioConfig });
    audio = res.audioContent as Uint8Array;
  }
  const durationMs = wavDurationMs(audio);
  if (!gemini) await recordTts(audio);

  if (!timed) {
    // Chirp 3 HD and Gemini-TTS: no timepoints → transcribe the WAV (Gemini: already done per take) and align.
    try {
      const aligned = alignWords(words, heard ?? (await transcribe(audio)), durationMs);
      timed = aligned.words;
      timing = aligned.method;
      matched = aligned.matched;
    } catch (e) {
      console.warn("[tts] STT alignment failed, using proportional timings", e);
      timed = alignWords(words, [], durationMs).words;
      timing = "proportional";
    }
  }

  await putObject(input.r2Key, audio, "audio/wav");
  return { sceneId: input.sceneId, key: input.r2Key, durationMs, words: displayTimedWords(timed, groups), timing, matched, chars: spoken.length, spokenText: spoken, pronunciationsApplied: applied, costUsd: ttsCost + sttCost };
}

/** One Gemini-TTS request (Cloud TTS v1, `input.prompt` + `voice.modelName`), LINEAR16 24 kHz like every other voice. */
async function geminiSpeech(text: string, languageCode: string, preset: Pick<VoicePreset, "voice" | "model" | "prompt">): Promise<Uint8Array> {
  const { ttsV1 } = clients();
  try {
    const [res] = await ttsV1.synthesizeSpeech({
      input: { text, ...(preset.prompt?.trim() ? { prompt: preset.prompt.trim() } : {}) },
      voice: { languageCode, name: preset.voice, modelName: preset.model ?? undefined },
      audioConfig: { audioEncoding: ttsProtos.google.cloud.texttospeech.v1.AudioEncoding.LINEAR16, sampleRateHertz: SAMPLE_RATE },
    });
    return res.audioContent as Uint8Array;
  } catch (e) {
    // Gemini-TTS runs on Gemini Enterprise Agent Platform (formerly Vertex AI): the project needs the Agent Platform API
    // (aiplatform.googleapis.com) on and the service account the Agent Platform User role (roles/aiplatform.user); docs/SETUP.md.
    if ((e as { code?: number }).code === 7) throw new Error(`Giọng Gemini chưa dùng được: bật Agent Platform API và cấp vai trò Agent Platform User (roles/aiplatform.user) cho service account Google TTS (${(e as Error).message.slice(0, 160)})`);
    throw e;
  }
}

/**
 * "Nghe thử" at /app/voices: a short sample in a voice that is not saved yet (or is). No R2, no timings; the cost is
 * recorded against the workspace like every synthesis.
 */
export async function synthesizeSample(
  input: { text: string; language: "vi" | "en"; preset: Pick<VoicePreset, "voice" | "model" | "prompt" | "rate" | "pitch" | "ssmlSupported"> },
  ctx: { userId: string; organizationId: string },
): Promise<{ wav: Uint8Array; durationMs: number; costUsd: number }> {
  const languageCode = GOOGLE_LANG[input.language];
  const text = input.text.trim().slice(0, 600);
  let wav: Uint8Array;
  if (input.preset.model) wav = await geminiSpeech(text, languageCode, input.preset);
  else {
    const [res] = await clients().ttsV1.synthesizeSpeech({
      input: { text },
      voice: { languageCode, name: input.preset.voice },
      audioConfig: { audioEncoding: ttsProtos.google.cloud.texttospeech.v1.AudioEncoding.LINEAR16, sampleRateHertz: SAMPLE_RATE, speakingRate: input.preset.rate },
    });
    wav = res.audioContent as Uint8Array;
  }
  const durationMs = wavDurationMs(wav);
  const costUsd = ttsCostUsd({ voice: input.preset.voice, model: input.preset.model, chars: text.length, promptChars: input.preset.prompt?.length ?? 0, durationMs });
  await recordUsageCost({ provider: "google_tts", resource: input.preset.model ? `${input.preset.model}:${input.preset.voice}` : input.preset.voice, units: text.length, unitType: "characters", costUsd, userId: ctx.userId, organizationId: ctx.organizationId, meta: { sample: true, durationMs } });
  return { wav, durationMs, costUsd };
}

/** Speech-to-Text v1 synchronous recognition with word offsets (audio ≤ 60 s). */
export async function transcribeWords(wav: Uint8Array, languageCode: string): Promise<SttWord[]> {
  const { stt } = clients();
  const base = {
    encoding: speechProtos.google.cloud.speech.v1.RecognitionConfig.AudioEncoding.LINEAR16,
    sampleRateHertz: SAMPLE_RATE,
    languageCode,
    enableWordTimeOffsets: true,
    enableAutomaticPunctuation: false,
  };
  const audio = { content: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString("base64") };
  let response;
  try {
    [response] = await stt.recognize({ config: { ...base, model: "latest_long" }, audio });
  } catch {
    [response] = await stt.recognize({ config: base, audio });
  }
  const out: SttWord[] = [];
  for (const r of response.results ?? []) {
    for (const w of r.alternatives?.[0]?.words ?? []) {
      if (w.word) out.push({ word: w.word, startMs: secondsToMs(w.startTime), endMs: secondsToMs(w.endTime) });
    }
  }
  return out;
}
