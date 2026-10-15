/**
 * The file name a finished render downloads as (the project's title, not the R2 key's `render-<id>.mp4`) and the
 * `Content-Disposition` R2 sends for it through a presigned GET (`presignGet(key, ttl, { downloadAs })`). Pure, tested.
 */

/** Longest name kept (in characters, before ".mp4"); file systems cap names at 255 bytes and Vietnamese takes 2–3 per letter. */
const NAME_MAX = 80;

/** A safe file name from a title: characters Windows / macOS refuse removed, whitespace collapsed, shortened at a word. */
export function videoFileName(title: string | null | undefined, ext = "mp4", fallback = "video"): string {
  let name = (title ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...name];
  if (chars.length > NAME_MAX) {
    const cut = chars.slice(0, NAME_MAX).join("");
    // Cut at the last word boundary unless the limit already falls on one.
    const space = chars[NAME_MAX] === " " ? cut.length : cut.lastIndexOf(" ");
    name = space > NAME_MAX / 2 ? cut.slice(0, space) : cut;
  }
  name = name.replace(/[\s.]+$/, "").replace(/^[\s.]+/, "");
  return `${name || fallback}.${ext}`;
}

/** ASCII stand-in for clients that ignore `filename*`: accents dropped, đ → d, anything else outside printable ASCII → _. */
export function asciiFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
}

/** `attachment` with both the ASCII name and the UTF-8 one (RFC 6266 / 5987), so the browser saves instead of playing. */
export function attachmentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encoded}`;
}
