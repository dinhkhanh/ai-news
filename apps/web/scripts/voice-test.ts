/**
 * Phase 1 Vietnamese voice listening test.
 * Synthesises the same news passage with every vi-VN Chirp 3 HD voice plus
 * the Neural2 SSML fallbacks, at rate 1.0, and writes MP3s + an index.html
 * to out/voice-test/. Open the HTML and pick the default narrator.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json pnpm --filter web exec tsx scripts/voice-test.ts
 */
import textToSpeech, { protos } from "@google-cloud/text-to-speech";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("out/voice-test");
const LANG = "vi-VN";

const PASSAGE = `Sáng nay, Ủy ban nhân dân Thành phố Hồ Chí Minh công bố kế hoạch mở rộng tuyến metro số một, với tổng vốn đầu tư khoảng bốn mươi ba nghìn tỷ đồng. Theo đó, giai đoạn hai sẽ kéo dài thêm mười hai ki-lô-mét về phía Đồng Nai và Bình Dương, dự kiến khởi công vào quý ba năm hai nghìn không trăm hai mươi bảy. Đại diện Ban Quản lý Đường sắt đô thị cho biết, lượng hành khách hiện đạt trung bình sáu mươi nghìn lượt mỗi ngày, cao hơn hai mươi phần trăm so với dự báo ban đầu.`;

const AUDIO: protos.google.cloud.texttospeech.v1.IAudioConfig = {
  audioEncoding: protos.google.cloud.texttospeech.v1.AudioEncoding.MP3,
  speakingRate: 1.0,
  sampleRateHertz: 24000,
};

async function main() {
  const client = new textToSpeech.TextToSpeechClient();
  const [{ voices }] = await client.listVoices({ languageCode: LANG });
  const candidates = (voices ?? [])
    .filter((v) => v.name && (v.name.includes("Chirp3-HD") || v.name.startsWith("vi-VN-Neural2")))
    .sort((a, b) => a.name!.localeCompare(b.name!));
  if (candidates.length === 0) throw new Error(`No Chirp 3 HD / Neural2 voices listed for ${LANG}`);

  await mkdir(OUT, { recursive: true });
  const rows: string[] = [];
  for (const v of candidates) {
    const name = v.name!;
    const isSsml = name.includes("Neural2");
    const input = isSsml ? { ssml: `<speak>${PASSAGE}</speak>` } : { text: PASSAGE };
    const started = Date.now();
    const [res] = await client.synthesizeSpeech({ input, voice: { languageCode: LANG, name }, audioConfig: AUDIO });
    const file = `${name}.mp3`;
    await writeFile(path.join(OUT, file), res.audioContent as Uint8Array);
    const ms = Date.now() - started;
    console.log(`${name.padEnd(30)} ${v.ssmlGender}  ${ms} ms`);
    rows.push(`<tr><td><code>${name}</code></td><td>${v.ssmlGender}</td><td>${isSsml ? "SSML" : "text"}</td><td>${ms} ms</td><td><audio controls preload="none" src="./${file}"></audio></td></tr>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>ai-news voice test ${LANG}</title>
<style>body{font-family:system-ui;padding:24px;max-width:1100px;margin:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:middle}audio{width:320px}</style>
<h1>Vietnamese voice listening test</h1><p>Passage (${PASSAGE.length} chars), rate 1.0, MP3 24 kHz. Plan default: <b>vi-VN-Chirp3-HD-Charon</b>, alternate Kore, SSML fallback Neural2-D.</p>
<blockquote>${PASSAGE}</blockquote>
<table><tr><th>Voice</th><th>Gender</th><th>Input</th><th>Latency</th><th>Listen</th></tr>${rows.join("")}</table>
<p>Score each 1–5 on: clarity of numbers/dates, proper-noun handling (Đồng Nai, Bình Dương), pacing for a 60 s short, naturalness. Record the winner in docs/PLAN.md §1.</p>`;
  await writeFile(path.join(OUT, "index.html"), html);
  console.log(`\nwrote ${candidates.length} samples to ${OUT}/index.html`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
