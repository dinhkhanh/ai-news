/**
 * Just enough PNG parsing to vet a brand overlay upload without an image
 * library: size from IHDR and whether the file can carry transparency
 * (RGBA / grey+alpha, or a palette / RGB file with a tRNS chunk, which is what
 * pngquant / TinyPNG produce). Pure; works on the first bytes of the file.
 */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type PngInfo = { width: number; height: number; hasAlpha: boolean };

/** `head` = the first bytes of the file (64 KB is plenty: tRNS comes before the first IDAT). Null = not a PNG. */
export function pngInfo(head: Uint8Array): PngInfo | null {
  if (head.length < 33 || SIGNATURE.some((b, i) => head[i] !== b)) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const type = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (type(12) !== "IHDR") return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colourType = head[25];
  let hasAlpha = colourType === 4 || colourType === 6;
  // Chunk = length(4) type(4) data(length) crc(4).
  for (let at = 8; !hasAlpha && at + 8 <= head.length; ) {
    const t = type(at + 4);
    if (t === "tRNS") hasAlpha = true;
    if (t === "IDAT" || t === "IEND") break;
    at += 12 + view.getUint32(at);
  }
  return { width, height, hasAlpha };
}
