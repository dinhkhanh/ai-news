import "server-only";
import { SpeechClient, protos as speechProtos } from "@google-cloud/speech";
import textToSpeech, { protos as ttsProtos } from "@google-cloud/text-to-speech";
import { and, eq, isNull, or } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { recordUsageCost } from "@/lib/activity";
import { putObject } from "@/lib/r2";
import { alignWords, type AlignResult, type SttWord, type TimedWord } from "./align";
import { GOOGLE_LANG, googleCredentials } from "./google";
import { applyPronunciations, splitWords, ssmlEscape } from "./pronounce";

/**
 * Voice-over synthesis (docs/PLAN.md §4.4): Google Cloud TTS with the workspace
 * voice preset and pronunciation dictionary. Word timings come from SSML marks
 * on Neural2 voices and from Speech-to-Text alignment on Chirp 3 HD voices.
 * Audio is LINEAR16 24 kHz WAV so STT and the media Lambda get lossless input.
 */
const SAMPLE_RATE = 24_000;
/** USD per character (Google list prices): Chirp 3 HD $30/1M, Neural2 $16/1M, Standard $4/1M. */
const TTS_PRICE = (voice: string) => (voice.includes("Chirp") ? 30 : voice.includes("Neural2") || voice.includes("Studio") ? 16 : 4) / 1_000_000;
/** STT v1 standard model, billed per 15 s increment. */
const STT_PRICE_PER_MIN = 0.024;

export type VoicePreset = { id: string; name: string; voice: string; language: "vi" | "en"; rate: number; pitch: number; ssmlSupported: boolean };

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

/** Workspace default preset for the language, else the platform default. */
export async function loadVoicePreset(ctx: { userId: string; organizationId: string }, language: "vi" | "en", presetId?: string | null): Promise<VoicePreset> {
  const rows = await withOrgContext(ctx, (tx) =>
    tx.query.voicePresets.findMany({
      where: and(eq(schema.voicePresets.language, language), or(eq(schema.voicePresets.organizationId, ctx.organizationId), isNull(schema.voicePresets.organizationId))),
    }),
  );
  const pick =
    (presetId && rows.find((r) => r.id === presetId)) ||
    rows.find((r) => r.organizationId === ctx.organizationId && r.isDefault) ||
    rows.find((r) => r.organizationId === null && r.isDefault) ||
    rows[0];
  if (!pick) throw new Error(`No voice preset for ${language}`);
  return { id: pick.id, name: pick.name, voice: pick.voice, language, rate: Number(pick.rate), pitch: Number(pick.pitch), ssmlSupported: pick.ssmlSupported };
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
  const { text: spoken, applied } = applyPronunciations(input.text, input.pronunciations);
  const words = splitWords(spoken);
  const languageCode = GOOGLE_LANG[input.language];
  const isChirp = input.preset.voice.includes("Chirp");
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

  if (input.preset.ssmlSupported && !isChirp) {
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
  const ttsCost = spoken.length * TTS_PRICE(input.preset.voice);
  await recordUsageCost({ provider: "google_tts", resource: input.preset.voice, units: spoken.length, unitType: "characters", costUsd: ttsCost, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { sceneId: input.sceneId, durationMs } });

  let sttCost = 0;
  if (!timed) {
    // Chirp 3 HD: no timepoints → transcribe the WAV and align.
    try {
      const sttWords = await transcribeWords(audio, languageCode);
      const aligned = alignWords(words, sttWords, durationMs);
      timed = aligned.words;
      timing = aligned.method;
      matched = aligned.matched;
      sttCost = (Math.ceil(durationMs / 15_000) * 15 / 60) * STT_PRICE_PER_MIN;
      await recordUsageCost({ provider: "google_stt", resource: "latest_long", units: durationMs / 1000, unitType: "seconds", costUsd: sttCost, userId: ctx.userId, organizationId: ctx.organizationId, projectId: ctx.projectId, meta: { sceneId: input.sceneId, matched, method: aligned.method } });
    } catch (e) {
      console.warn("[tts] STT alignment failed, using proportional timings", e);
      timed = alignWords(words, [], durationMs).words;
      timing = "proportional";
    }
  }

  await putObject(input.r2Key, audio, "audio/wav");
  return { sceneId: input.sceneId, key: input.r2Key, durationMs, words: timed, timing, matched, chars: spoken.length, spokenText: spoken, pronunciationsApplied: applied, costUsd: ttsCost + sttCost };
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
