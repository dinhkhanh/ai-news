"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Sticky action bar: sits under the top edge while the page scrolls, one row that
 * scrolls sideways on phones so nothing wraps or shrinks. Put the page's most-used
 * actions here (`children`); `tabs` is a row of section jumps rendered under them.
 */
export function StickyToolbar({
  children,
  tabs,
  className,
}: {
  children?: React.ReactNode;
  tabs?: React.ReactNode;
  className?: string;
}) {
  // One sticky bar per page: while this toolbar is mounted the site header scrolls away (see app/layout.tsx).
  useEffect(() => {
    document.documentElement.setAttribute("data-own-bar", "");
    return () => document.documentElement.removeAttribute("data-own-bar");
  }, []);
  return (
    <div
      className={cn(
        "sticky top-2 z-30 rounded-xl border bg-card/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/85",
        className,
      )}
    >
      {children ? (
        <div className="flex items-center gap-2 overflow-x-auto px-2 py-1.5 scrollbar-none fade-x [&>*]:shrink-0">
          {children}
        </div>
      ) : null}
      {tabs ? (
        <div className={cn("overflow-x-auto px-2 scrollbar-none fade-x", children && "border-t")}>{tabs}</div>
      ) : null}
    </div>
  );
}

export type SectionTab = { id: string; label: string; icon?: React.ReactNode };

/**
 * Icon + label jump links to page sections (`id`s), with the reference's blue
 * underline on the section currently in view. Plain anchors: they work before
 * hydration, and `scroll-padding-top` in globals.css keeps the target clear of the bar.
 */
export function SectionTabs({ tabs, className }: { tabs: SectionTab[]; className?: string }) {
  const [active, setActive] = useState<string | null>(tabs[0]?.id ?? null);
  const ids = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    const els = ids
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!els.length) return;
    const update = () => {
      // The section whose top is closest above the bar wins; the first one before anything scrolled.
      // The bar sits 8 px under the top edge; the header above it is not sticky on these pages (56 px less than before).
      const line = 144;
      let best: string | null = null;
      let bestTop = -Infinity;
      for (const el of els) {
        const top = el.getBoundingClientRect().top;
        if (top <= line && top > bestTop) {
          best = el.id;
          bestTop = top;
        }
      }
      setActive(best ?? els[0].id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);
  return (
    <nav aria-label="Mục trong trang" className={cn("flex min-w-max items-stretch gap-1", className)}>
      {tabs.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          aria-current={active === t.id ? "location" : undefined}
          className={cn(
            "relative inline-flex min-h-10 items-center gap-1.5 px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11",
            "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity",
            active === t.id && "text-primary after:opacity-100",
          )}
        >
          {t.icon ? <span className="[&>svg]:size-4">{t.icon}</span> : null}
          {t.label}
        </a>
      ))}
    </nav>
  );
}
