"use client";
import { useLayoutEffect, useRef } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  title: React.ReactNode;
  /** Short readout shown in the header while collapsed (and, with `summaryAlways`, while open). */
  summary?: React.ReactNode;
  summaryAlways?: boolean;
  /** `true` / `false`, or `"desktop"` = open on screens ≥ 1024 px and collapsed on phones. */
  defaultOpen?: boolean | "desktop";
  /** Extra controls on the right of the header (must stop propagation themselves if they should not toggle). */
  actions?: React.ReactNode;
  id?: string;
  className?: string;
  bodyClassName?: string;
  /** Plain: no card chrome, only the header row and a divider. */
  variant?: "card" | "plain";
  children: React.ReactNode;
};

const DESKTOP = "(min-width: 1024px)";

/**
 * Native `<details>` section: keyboard and screen-reader friendly, no JS needed
 * to toggle, and the header is a full-width 44 px touch target. `defaultOpen="desktop"`
 * renders open (so server HTML shows content) and collapses before first paint on
 * small screens.
 */
export function CollapsibleSection({ title, summary, summaryAlways, defaultOpen = true, actions, id, className, bodyClassName, variant = "card", children }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (defaultOpen === "desktop" && ref.current && !window.matchMedia(DESKTOP).matches) ref.current.open = false;
  }, [defaultOpen]);
  return (
    <details
      ref={ref}
      id={id}
      open={defaultOpen === true || defaultOpen === "desktop"}
      className={cn("group/section scroll-mt-24", variant === "card" && "rounded-xl bg-card shadow-xs ring-1 ring-border", className)}
    >
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer items-center gap-2 select-none rounded-xl px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
          variant === "card" ? "hover:bg-sidebar group-open/section:rounded-b-none" : "px-0",
        )}
      >
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open/section:rotate-90" aria-hidden />
        <span className="min-w-0 truncate font-medium">{title}</span>
        {summary ? <span className={cn("ml-auto min-w-0 truncate text-right text-xs text-muted-foreground", !summaryAlways && "group-open/section:hidden")}>{summary}</span> : null}
        {actions ? <span className={cn("flex shrink-0 items-center gap-1", !summary && "ml-auto")}>{actions}</span> : null}
      </summary>
      <div className={cn(variant === "card" ? "border-t px-3 py-3 sm:px-4" : "pt-2", bodyClassName)}>{children}</div>
    </details>
  );
}
