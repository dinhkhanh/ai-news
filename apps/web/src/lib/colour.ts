/**
 * Brand colours are stored as CSS hex: `#rrggbb`, or `#rrggbbaa` when not fully
 * opaque. Pure helpers for the colour field at /app/brand and its server check;
 * older kits may still hold `rgba(…)` (the former caption background default).
 */
export type Rgba = { hex: string; alpha: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` → 6-digit hex + alpha 0–1; null = not a colour we accept. */
export function parseColour(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    return { hex: `#${full.slice(0, 6)}`, alpha: full.length === 8 ? Math.round((parseInt(full.slice(6), 16) / 255) * 100) / 100 : 1 };
  }
  const m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  if (r > 255 || g > 255 || b > 255) return null;
  const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (!Number.isFinite(a)) return null;
  return { hex: `#${byte(r)}${byte(g)}${byte(b)}`, alpha: Math.round(clamp01(a) * 100) / 100 };
}

/** `#rrggbb` when opaque, else `#rrggbbaa`. */
export function formatColour({ hex, alpha }: Rgba) {
  const a = clamp01(alpha);
  return a >= 0.995 ? hex.toLowerCase() : `${hex.toLowerCase()}${byte(a * 255)}`;
}

/** Canonical stored form of any accepted input, or null. */
export function normaliseColour(input: string) {
  const c = parseColour(input);
  return c ? formatColour(c) : null;
}
