"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatColour, parseColour, type Rgba } from "@/lib/colour";

const CHECKER = "repeating-conic-gradient(#d4d4d8 0% 25%, #ffffff 0% 50%) 0 0 / 10px 10px";

/** Colour picker + opacity slider + hex field; submits `#rrggbb` or `#rrggbbaa` under `name`. */
export function ColourField({ name, label, value, hint }: { name: string; label: string; value: string; hint?: string }) {
  const [colour, setColour] = useState<Rgba>(() => parseColour(value) ?? { hex: "#000000", alpha: 1 });
  const [text, setText] = useState(() => formatColour(parseColour(value) ?? { hex: "#000000", alpha: 1 }));
  const set = (next: Rgba) => {
    setColour(next);
    setText(formatColour(next));
  };
  const css = formatColour(colour);
  const pct = Math.round(colour.alpha * 100);
  return (
    <div className="space-y-1">
      <Label htmlFor={`${name}-text`}>{label}</Label>
      <input type="hidden" name={name} value={css} />
      <div className="flex items-center gap-2">
        {/* The swatch is the native picker: the input covers it, invisible; the checkerboard shows through a translucent colour. */}
        <label className="relative h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded border" style={{ background: CHECKER }} title="Chọn màu">
          <span className="absolute inset-0" style={{ background: css }} aria-hidden />
          <input type="color" value={colour.hex} onChange={(e) => set({ ...colour, hex: e.target.value })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`${label}: chọn màu`} />
        </label>
        <Input
          id={`${name}-text`}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            const parsed = parseColour(e.target.value);
            if (parsed) setColour(parsed);
          }}
          onBlur={() => setText(css)}
          className="w-28 font-mono text-xs"
          aria-invalid={parseColour(text) ? undefined : true}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => set({ ...colour, alpha: Number(e.target.value) / 100 })}
          className="w-full max-w-40 cursor-pointer"
          style={{ accentColor: colour.hex }}
          aria-label={`${label}: độ đậm`}
        />
        <span className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">đậm {pct}%</span>
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
