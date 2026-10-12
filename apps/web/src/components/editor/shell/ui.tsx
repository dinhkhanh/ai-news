"use client";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Header of a left panel: title, a muted count / summary, and actions on the right. */
export function PanelHeader({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
      <h2 className="min-w-0 truncate text-sm font-semibold">
        {title}
        {meta != null ? <span className="font-normal text-muted-foreground"> · {meta}</span> : null}
      </h2>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}

/** A labelled group inside a panel or inspector tab. */
export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Small amber / red / grey note. */
export function Note({ tone = "warn", children, className }: { tone?: "warn" | "danger" | "info" | "ok"; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2 text-xs",
        tone === "warn" && "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "info" && "bg-muted text-muted-foreground",
        tone === "ok" && "border-success/40 bg-success/10 text-success",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Picture or clip thumbnail (a clip without a remote thumbnail shows its first frame). */
export function Thumb({ src, video, className }: { src: string | null; video: boolean; className?: string }) {
  if (!src) return null;
  return video ? (
    <video src={src} muted preload="metadata" className={cn("h-full w-full object-cover", className)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn("h-full w-full object-cover", className)} loading="lazy" draggable={false} />
  );
}

/** Segmented single choice (radio group semantics). */
export function Choice<T extends string>({ value, options, onChange, disabled, label, className }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-1 rounded-lg border bg-muted/50 p-0.5", className)} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn("min-h-8 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 pointer-coarse:min-h-10", value === o.value && "bg-card text-foreground shadow-xs")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Keyboard hint chip. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}

export const SEVERITY_DOT = { fix: "bg-destructive", should: "bg-amber-500", info: "bg-muted-foreground/50" } as const;
export const SEVERITY_LABEL = { fix: "cần sửa", should: "nên sửa", info: "lưu ý" } as const;

/** "12,4 s" / "00:12.4". */
export const fmtSec = (sec: number) => `${sec.toFixed(1).replace(".", ",")} s`;
export const timecode = (sec: number) => {
  const s = Math.max(0, sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
