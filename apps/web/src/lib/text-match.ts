/** Locate `needle` in `text` tolerating whitespace, quote and case differences. Returns [start, end) or null. */
export function findRange(text: string, needle: string | null | undefined): [number, number] | null {
  if (!needle) return null;
  const clean = needle.replace(/[“”"'‘’«»]/g, "").trim();
  if (clean.length < 8) return null;
  const tryFind = (n: string) => {
    const pattern = n
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s“”\"'‘’«»]*");
    const re = new RegExp(pattern, "iu");
    const m = re.exec(text);
    return m ? ([m.index, m.index + m[0].length] as [number, number]) : null;
  };
  return tryFind(clean) ?? tryFind(clean.slice(0, 80)) ?? tryFind(clean.slice(0, 40));
}
