"use client";
import { Fragment } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { LogoMark } from "@/components/logo-mark";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type RailItem = { href: string; label: string; icon: LucideIcon };

/** The short dashed rule between rail groups. */
function RailRule() {
  return <span className="my-2.5 block w-7 border-t border-dashed border-foreground/15" aria-hidden />;
}

/**
 * The reference's icon rail (`sm` and up): logo mark, then groups of 36 px icon tiles
 * split by dashed rules. The current section is a white tile with a hairline and a soft
 * shadow; labels live in tooltips (and `aria-label`). Phones use the bottom tab bar or
 * the admin strip instead.
 */
export function NavRail({
  label,
  homeHref,
  groups,
  isActive,
}: {
  label: string;
  homeHref: string;
  groups: RailItem[][];
  isActive: (item: RailItem) => boolean;
}) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col items-center bg-sidebar pt-4 pb-3 sm:flex">
      <Link href={homeHref} aria-label="ai-news" className="flex size-10 items-center justify-center rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
        <LogoMark />
      </Link>
      <RailRule />
      <TooltipProvider>
        <nav aria-label={label} className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-2 pt-1 scrollbar-none">
          {groups.map((group, i) => (
            <Fragment key={group[0]?.href ?? i}>
              {i > 0 ? <RailRule /> : null}
              <ul className="flex flex-col items-center gap-1">
                {group.map((item) => {
                  const active = isActive(item);
                  return (
                    <li key={item.href}>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Link
                              href={item.href}
                              aria-label={item.label}
                              aria-current={active ? "page" : undefined}
                              className={cn(
                                "flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 pointer-coarse:size-11",
                                active && "bg-sidebar-accent text-foreground shadow-xs ring-1 ring-sidebar-border hover:bg-sidebar-accent",
                              )}
                            />
                          }
                        >
                          <item.icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                        </TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          ))}
        </nav>
      </TooltipProvider>
    </aside>
  );
}
