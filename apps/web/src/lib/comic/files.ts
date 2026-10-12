/**
 * Export file writers for the comic studio (docs/COMIC.md §2.7, M3), pure and dependency-free: a zip (stored, the
 * pictures are compressed already) and a PDF of JPEG pages. Both build the whole file in memory, which is fine for
 * a comic of at most 40 pages.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const dosTime = (d: Date) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

/** A zip archive with every entry stored (method 0); names are UTF-8 (flag bit 11). Not for archives over 4 GB. */
export function zipStore(entries: { name: string; data: Uint8Array }[], at = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(at);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, e.data.length, true);
    dir.setUint32(24, e.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, e.data);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return concat([...chunks, ...central, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Physical page sizes (PDF points) of the print formats; screen formats print at 96 dpi. */
const PRINT_WIDTH_PT: Record<string, number> = { a4: 595.28, us_comic: 477, manga_b6: 362.83 };

/** PDF page size for a page of `widthPx` × `heightPx` in the comic's format (the height follows the page's aspect). */
export function pdfPageSize(formatId: string, widthPx: number, heightPx: number) {
  const w = PRINT_WIDTH_PT[formatId] ?? widthPx * 0.75;
  return { w: round2(w), h: round2((w * heightPx) / widthPx) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** PDF text string: ASCII as a literal, anything else as UTF-16BE hex (Vietnamese titles). */
function pdfString(s: string) {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

/**
 * A PDF with one JPEG per page, each filling its page (`w` × `h` points). `width` / `height` are the JPEG's pixel
 * size; the pictures are RGB (Remotion's JPEG stills).
 */
export function jpegPdf(pages: { jpeg: Uint8Array; width: number; height: number; w: number; h: number }[], info: { title: string; creator?: string }) {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (p: Uint8Array | string) => {
    const b = typeof p === "string" ? enc.encode(p) : p;
    parts.push(b);
    size += b.length;
  };
  const object = (id: number, body: (string | Uint8Array)[]) => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
    for (const b of body) push(b);
    push("\nendobj\n");
  };
  // 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageId = (i: number) => 4 + i * 3;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  object(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`]);
  object(3, [`<< /Title ${pdfString(info.title)} /Producer ${pdfString(info.creator ?? "ai-news comic studio")} >>`]);
  pages.forEach((p, i) => {
    const id = pageId(i);
    const content = `q ${p.w} 0 0 ${p.h} 0 0 cm /Im0 Do Q`;
    object(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`]);
    object(id + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    object(id + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, "\nendstream"]);
  });
  const count = 4 + pages.length * 3;
  const xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return concat(parts);
}
