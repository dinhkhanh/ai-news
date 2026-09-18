"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Sticky action bar, drawn as a flush white band of the panel (`band` in globals.css) with
 * the tab underline resting on its hairline, as in the reference. It sticks to the top edge while the page scrolls, one row that
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
        "band sticky top-0 z-30",
        className,
      )}
    >
      {children ? (
        <div className="flex items-center gap-2 overflow-x-auto py-2 scrollbar-none fade-x [&>*]:shrink-0">
          {children}
        </div>
      ) : null}
      {tabs ? (
        <div className="overflow-x-auto scrollbar-none fade-x">{tabs}</div>
      ) : null}
    </div>
  );
}

export type SectionTab = { id: string; label: string; icon?: React.ReactNode };

/**
 * Icon + label jump links to page sections (`id`s), with the reference's blue
 * underline on the section currently in view. Plain anchors: they work before
 * hydration, and `scroll-padding-top` in globals.css keeps the target clear of the bar.
 *
 * Sections can sit side by side (a narrow column beside the main one), where the scroll
 * position cannot tell them apart. So the scroll position follows the widest column only,
 * and a tab that was clicked keeps the underline for as long as its section is on screen
 * and the scroll position has not moved on to another section.
 */
export function SectionTabs({ tabs, className }: { tabs: SectionTab[]; className?: string }) {
  const [active, setActive] = useState<string | null>(tabs[0]?.id ?? null);
  const nav = useRef<HTMLElement>(null);
  const hashRead = useRef(false);
  const ids = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    const els = ids
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!els.length) return;
    // The bar sits at the top edge; the top bar above it is not sticky on these pages.
    const line = 128;
    const derive = () => {
      const rects = els.map((el) => el.getBoundingClientRect());
      // A section beside a wider one (review next to the script) is a side column: it only wins when the main column has nothing.
      const side = rects.map((r, i) =>
        rects.some((o, j) => j !== i && o.width > r.width + 1 && o.top < r.bottom && r.top < o.bottom),
      );
      // At the end of the page the last sections cannot reach the line any more: whatever is on screen counts.
      const atEnd =
        window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      const limit = atEnd ? window.innerHeight : line;
      // The section whose top is closest above the bar wins; the first one before anything scrolled.
      let best = -1;
      rects.forEach((r, i) => {
        if ((!r.width && !r.height) || r.top > limit) return;
        if (best < 0 || (side[best] && !side[i]) || (side[i] === side[best] && r.top > rects[best].top)) best = i;
      });
      return els[Math.max(best, 0)].id;
    };
    // The clicked tab, and the section the scroll position pointed at once the jump had settled (null = still scrolling there).
    let picked: { id: string; over: string | null } | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const derived = derive();
      if (picked) {
        const r = document.getElementById(picked.id)?.getBoundingClientRect();
        const onScreen = Boolean(r && r.bottom > line && r.top < window.innerHeight);
        if (picked.over === null || (onScreen && picked.over === derived)) return setActive(picked.id);
        picked = null;
      }
      setActive(derived);
    };
    const arm = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (picked?.over === null) picked.over = derive();
        update();
      }, 150);
    };
    const pick = (id: string) => {
      if (!els.some((el) => el.id === id)) return;
      picked = { id, over: null };
      arm();
    };
    const onScroll = () => {
      if (picked?.over === null) arm();
      update();
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[href^='#']");
      if (a) pick(a.getAttribute("href")!.slice(1));
      update();
    };
    // Arriving with a #section in the URL counts as a click on that tab.
    if (!hashRead.current) {
      hashRead.current = true;
      pick(window.location.hash.slice(1));
    }
    update();
    const navEl = nav.current;
    navEl?.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      clearTimeout(settle);
      navEl?.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
    };
  }, [ids]);
  return (
    <nav ref={nav} aria-label="Mục trong trang" className={cn("flex min-w-max items-stretch gap-3", className)}>
      {tabs.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          aria-current={active === t.id ? "location" : undefined}
          className={cn(
            "relative inline-flex min-h-11 items-center gap-2 px-2 text-[0.9375rem] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11",
            "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity",
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
