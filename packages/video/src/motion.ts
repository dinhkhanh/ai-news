import { z } from "zod";

/**
 * Motion graphics (0.15.0): a shot drawn by code instead of a photo or clip,
 * designed by Claude from the scene's script and word timings. Two engines:
 *
 * - `remotion`: Claude writes a `MotionSpec` (beats of typed elements: title,
 *   big number, bar chart, list, quote, timeline…) that `Motion.tsx` draws
 *   with the brand colours. Safe and consistent: no code is generated.
 * - `hyperframes`: Claude writes a HyperFrames composition (HTML + CSS + a
 *   paused GSAP timeline registered in `window.__timelines`, the format of
 *   github.com/heygen-com/hyperframes). `HyperFramesShot.tsx` loads it in a
 *   sandboxed iframe (`hyperframesDocument`) and seeks the timeline to every
 *   frame, so it renders deterministically inside the same Remotion render.
 *
 * Projects choose `MOTION_MODES` (none / scenes Claude picks / every scene)
 * and an engine; the editor can turn any single shot into a motion shot.
 * Shared by the composition and the web app; the spec schema is also the
 * structured-output schema of the Claude call, so every field is required
 * (nullable instead of optional) and there are no numeric bounds.
 */
export const MOTION_MODES = ["off", "auto", "all"] as const;
export type MotionMode = (typeof MOTION_MODES)[number];
export const MOTION_ENGINES = ["remotion", "hyperframes"] as const;
export type MotionEngine = (typeof MOTION_ENGINES)[number];

/** `video` = the shot's backdrop (a clip or a picture, dimmed; `MotionBackdrop.tsx`); falls back to `gradient` when the shot has none. */
export const MOTION_BACKGROUNDS = ["gradient", "grid", "dots", "rays", "image", "video"] as const;
export const MOTION_MOODS = ["brand", "dark", "light", "alert"] as const;
export const MOTION_ELEMENTS = ["kicker", "title", "text", "stat", "bars", "list", "quote", "timeline", "compare", "icon", "image"] as const;
export type MotionElementType = (typeof MOTION_ELEMENTS)[number];
export const MOTION_ENTERS = ["fade", "rise", "pop", "slide", "type", "wipe"] as const;

export const motionItemSchema = z.object({
  label: z.string().describe("Bar / list / timeline label, a date for a timeline, a side of a comparison"),
  value: z.number().nullable().describe("Numeric value for bars and comparisons; null elsewhere"),
  detail: z.string().nullable().describe("Short second line (timeline event, comparison note); null if none"),
});
export type MotionItem = z.infer<typeof motionItemSchema>;

export const motionElementSchema = z.object({
  type: z.enum(MOTION_ELEMENTS),
  delay: z.number().describe("Seconds after the start of its beat when the element appears"),
  enter: z.enum(MOTION_ENTERS),
  text: z.string().nullable().describe("Main text: title, text, quote, stat label, image caption; null when unused"),
  label: z.string().nullable().describe("Kicker text, quote attribution, unit line of a chart; null when unused"),
  value: z.number().nullable().describe("The number of a stat (counts up); null elsewhere"),
  prefix: z.string().nullable().describe("Before the stat value, e.g. '$'; null if none"),
  suffix: z.string().nullable().describe("After the stat / bar values, e.g. '%', ' tỷ', ' km'; null if none"),
  decimals: z.number().int().nullable().describe("Decimals shown for stat / bar values; null = 0"),
  items: z.array(motionItemSchema).nullable().describe("bars (2-6), list (2-5), timeline (2-5), compare (exactly 2); null elsewhere"),
  emoji: z.string().nullable().describe("A single emoji for an icon element; null elsewhere"),
  image: z.number().int().nullable().describe("Index into the shot's images for an image element; null elsewhere"),
  emphasis: z.array(z.string()).nullable().describe("Words of `text` drawn in the accent colour; null if none"),
});
export type MotionElement = z.infer<typeof motionElementSchema>;

export const motionBeatSchema = z.object({
  at: z.number().describe("Seconds from the start of the shot; the first beat starts at 0, each beat replaces the previous one"),
  align: z.enum(["center", "top"]),
  elements: z.array(motionElementSchema),
});
export type MotionBeat = z.infer<typeof motionBeatSchema>;

export const motionSpecSchema = z.object({
  mood: z.enum(MOTION_MOODS).describe("brand = the kit's colours, dark, light (paper), alert (breaking / danger)"),
  background: z.enum(MOTION_BACKGROUNDS),
  backgroundImage: z.number().int().nullable().describe("Index into the shot's images when background is 'image'; null otherwise"),
  beats: z.array(motionBeatSchema),
});
export type MotionSpec = z.infer<typeof motionSpecSchema>;

/** What Claude returns for the HyperFrames engine. */
export const hyperframesOutputSchema = z.object({
  html: z.string().describe("The HyperFrames composition: one root element with data-composition-id, a <style> and an inline <script> registering a paused GSAP timeline"),
  summary: z.string().describe("One sentence in the video's language describing the shot for the editor"),
  videoBackground: z.boolean().describe("True when the composition leaves the stage background transparent so the provided video clip plays behind it; false when no clip is provided or you painted your own background"),
});
export type HyperframesOutput = z.infer<typeof hyperframesOutputSchema>;

/** Composition id Claude must register its timeline under. */
export const HYPERFRAMES_COMPOSITION_ID = "shot";
/** Pinned GSAP build the shell loads (the composition must not load scripts itself). */
export const HYPERFRAMES_GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js";
/** Largest composition accepted (characters); the HTML travels inline in the timeline JSON. */
export const HYPERFRAMES_MAX_CHARS = 60_000;

/**
 * Normalise a model-written spec: beats sorted and starting at 0, times and
 * counts clamped to something drawable. Pure; used before storing and again
 * by the composition (stored specs are never trusted blindly).
 */
export function normaliseMotionSpec(spec: MotionSpec, durationSec: number): MotionSpec {
  const end = Math.max(0.5, durationSec);
  const beats = [...spec.beats]
    .filter((b) => b.elements.length > 0)
    .map((b) => ({ ...b, at: Math.min(Math.max(0, Number.isFinite(b.at) ? b.at : 0), end - 0.4) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 6)
    .map((b) => ({
      ...b,
      elements: b.elements.slice(0, 5).map((e) => ({
        ...e,
        delay: Math.min(Math.max(0, Number.isFinite(e.delay) ? e.delay : 0), 6),
        decimals: e.decimals == null ? null : Math.min(Math.max(0, Math.round(e.decimals)), 3),
        items: e.items ? e.items.slice(0, e.type === "compare" ? 2 : 6) : null,
      })),
    }));
  if (beats.length) beats[0] = { ...beats[0], at: 0 };
  return { ...spec, beats };
}

/** "12.500", "3,5" (vi) / "12,500", "3.5" (en). */
export function formatMotionNumber(value: number, decimals: number, language: "vi" | "en") {
  const [int, frac] = Math.abs(value).toFixed(decimals).split(".");
  const sep = language === "vi" ? "." : ",";
  const dec = language === "vi" ? "," : ".";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${value < 0 ? "−" : ""}${grouped}${frac ? dec + frac : ""}`;
}

/** Strip what a composition may not carry: external scripts, other iframes, meta refreshes, base tags. */
export function sanitiseHyperframesHtml(html: string) {
  return html
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*\/?>/gi, "")
    .replace(/<(iframe|object|embed|base|link)\b[^>]*>(?:[\s\S]*?<\/\1\s*>)?/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .trim();
}

/** Problems that make a composition unusable (empty list = fine). */
export function checkHyperframesHtml(html: string): string[] {
  const out: string[] = [];
  if (!html.trim()) out.push("empty composition");
  if (html.length > HYPERFRAMES_MAX_CHARS) out.push(`composition longer than ${HYPERFRAMES_MAX_CHARS} characters`);
  if (!/data-composition-id\s*=/.test(html)) out.push("no element with data-composition-id");
  if (!/__timelines/.test(html)) out.push("no timeline registered in window.__timelines");
  if (/\bMath\.random\s*\(|\bDate\.now\s*\(|new\s+Date\s*\(|\bsetInterval\s*\(|requestAnimationFrame\s*\(/.test(html)) out.push("uses wall-clock or random APIs (not seekable)");
  return out;
}

export type HyperframesDocumentInput = {
  html: string;
  /** Resolved URLs for `{{image:N}}` placeholders. */
  images: string[];
  colours: { primary: string; accent: string; background: string; text: string; highlight: string };
  fontFamily: string;
  /** Lowest y (px) the composition may draw text at: the captions start below it. */
  safeBottom: number;
  /**
   * A backdrop (clip or picture) shows under the iframe: the page and the composition's root element are forced
   * transparent, so the editor can swap the backdrop behind an existing composition without touching its motion.
   */
  transparent?: boolean;
};

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The `srcdoc` of a HyperFrames shot: a locked-down page (CSP: inline code +
 * pinned GSAP + Google Fonts + https images only, no network calls from
 * script) with the brand as CSS variables, the composition, and a small
 * bridge: the parent posts `{type: "hf-seek", t, n}`, the page seeks every
 * registered timeline, shows / hides `[data-start][data-duration]` clips like
 * the HyperFrames runtime does, waits two frames and answers `hf-seeked`.
 * `hf-ready` is posted once fonts and images are loaded.
 */
export function hyperframesDocument(input: HyperframesDocumentInput): string {
  let html = sanitiseHyperframesHtml(input.html);
  input.images.forEach((url, i) => {
    html = html.split(`{{image:${i}}}`).join(escapeAttr(url));
  });
  const c = input.colours;
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "connect-src 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@500;700;800;900&family=Inter:wght@500;700;800;900&display=block&subset=vietnamese">
<style>
:root{--brand-primary:${c.primary};--brand-accent:${c.accent};--brand-bg:${c.background};--brand-text:${c.text};--brand-highlight:${c.highlight};--font:${input.fontFamily},'Be Vietnam Pro',sans-serif;--safe-bottom:${input.safeBottom}px}
html,body{margin:0;padding:0;width:1080px;height:1920px;overflow:hidden;background:${input.transparent ? "transparent" : "var(--brand-bg)"};color:var(--brand-text);font-family:var(--font)}
*{box-sizing:border-box}${input.transparent ? "\n[data-composition-id]{background:transparent!important}" : ""}
</style>
<script src="${HYPERFRAMES_GSAP_URL}"></script>
</head><body>
${html}
<script>
(function(){
  var ready=false,pending=null;
  function seek(t){
    var tls=window.__timelines||{};
    for(var k in tls){try{tls[k].seek(t,false);}catch(e){}}
    var clips=document.querySelectorAll('[data-start]');
    for(var i=0;i<clips.length;i++){var el=clips[i];if(el.hasAttribute('data-composition-id'))continue;
      var s=parseFloat(el.getAttribute('data-start'))||0,d=parseFloat(el.getAttribute('data-duration'));
      el.style.visibility=(t>=s&&(isNaN(d)||t<s+d))?'':'hidden';}
  }
  function answer(n){requestAnimationFrame(function(){requestAnimationFrame(function(){parent.postMessage({type:'hf-seeked',n:n},'*');});});}
  window.addEventListener('message',function(e){var m=e.data;if(!m||m.type!=='hf-seek')return;
    var go=function(){seek(m.t);answer(m.n);};if(ready)go();else pending=go;});
  function imagesLoaded(){var imgs=[].slice.call(document.images);return Promise.all(imgs.map(function(im){return im.complete?0:new Promise(function(r){im.onload=im.onerror=r;});}));}
  var fonts=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();
  Promise.race([Promise.all([fonts,imagesLoaded()]),new Promise(function(r){setTimeout(r,15000);})]).then(function(){
    ready=true;seek(0);parent.postMessage({type:'hf-ready'},'*');if(pending){var p=pending;pending=null;p();}});
})();
</script>
</body></html>`;
}
