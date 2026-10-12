"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { LogoMark } from "@/components/logo-mark";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_EXPANDED_COOKIE } from "@/lib/nav-prefs";
import { cn } from "@/lib/utils";

export type RailItem = { href: string; label: string; icon: LucideIcon };

/** The short dashed rule between rail groups. */
function RailRule({ wide }: { wide: boolean }) {
  return <span className={cn("my-2.5 block border-t border-dashed border-foreground/15", wide ? "w-full" : "w-7")} aria-hidden />;
}

/** Remember the choice for a year; the layouts read it on the server so the first paint already has the right width. */
function remember(expanded: boolean) {
  document.cookie = `${NAV_EXPANDED_COOKIE}=${expanded ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * The reference's icon rail (`sm` and up): logo mark, then groups of 36 px icon tiles
 * split by dashed rules. The current section is a white tile with a hairline and a soft
 * shadow. Collapsed (default) the labels live in tooltips (and `aria-label`); expanded
 * the rail widens to show each label beside its icon. The toggle at the bottom switches,
 * remembered per browser (`NAV_EXPANDED_COOKIE`). Phones use the bottom tab bar or the
 * admin strip instead.
 */
export function NavRail({
  label,
  homeHref,
  groups,
  isActive,
  defaultExpanded = false,
}: {
  label: string;
  homeHref: string;
  groups: RailItem[][];
  isActive: (item: RailItem) => boolean;
  /** From the cookie, read by the layout. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = () => {
    setExpanded(!expanded);
    remember(!expanded);
  };
  const ToggleIcon = expanded ? PanelLeftClose : PanelLeftOpen;

  return (
    <aside className={cn("sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar pt-4 pb-3 transition-[width] duration-200 ease-out motion-reduce:transition-none sm:flex", expanded ? "w-56 items-stretch px-3" : "w-16 items-center")}>
      <Link href={homeHref} aria-label="ai-news" className={cn("flex h-10 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40", expanded ? "px-2" : "w-10 justify-center")}>
        <LogoMark />
        {expanded ? <span className="text-sm font-semibold tracking-tight">ai-news</span> : null}
      </Link>
      <RailRule wide={expanded} />
      <TooltipProvider>
        <nav aria-label={label} className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto pt-1 scrollbar-none", expanded ? "items-stretch" : "items-center px-2")}>
          {groups.map((group, i) => (
            <Fragment key={group[0]?.href ?? i}>
              {i > 0 ? <RailRule wide={expanded} /> : null}
              <ul className={cn("flex flex-col gap-1", expanded ? "items-stretch" : "items-center")}>
                {group.map((item) => {
                  const active = isActive(item);
                  const cls = cn(
                    "flex items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
                    expanded ? "h-9 gap-2.5 px-2.5 text-sm font-medium pointer-coarse:h-11" : "size-9 justify-center pointer-coarse:size-11",
                    active && "bg-sidebar-accent text-foreground shadow-xs ring-1 ring-sidebar-border hover:bg-sidebar-accent",
                  );
                  return (
                    <li key={item.href}>
                      {expanded ? (
                        <Link href={item.href} aria-current={active ? "page" : undefined} className={cls}>
                          <item.icon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger render={<Link href={item.href} aria-label={item.label} aria-current={active ? "page" : undefined} className={cls} />}>
                            <item.icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                          </TooltipTrigger>
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          ))}
        </nav>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={toggle}
                aria-expanded={expanded}
                aria-label={expanded ? "Thu gọn thanh bên" : "Mở rộng thanh bên"}
                className={cn("mt-2 flex items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40", expanded ? "h-9 gap-2.5 px-2.5 text-sm pointer-coarse:h-11" : "size-9 justify-center pointer-coarse:size-11")}
              />
            }
          >
            <ToggleIcon className="size-[18px] shrink-0" strokeWidth={1.75} aria-hidden />
            {expanded ? <span>Thu gọn</span> : null}
          </TooltipTrigger>
          {expanded ? null : <TooltipContent side="right">Mở rộng thanh bên</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
    </aside>
  );
}
