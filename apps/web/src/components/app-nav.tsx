"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Palette, Radio, Send, ShieldCheck, type LucideIcon } from "lucide-react";
import { NavRail } from "@/components/nav-rail";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; icon: LucideIcon; exact?: boolean };

export function appNavItems(admin: boolean): Item[] {
  return [
    { href: "/app", label: "Dự án", icon: FolderKanban },
    { href: "/app/publications", label: "Đã đăng", icon: Send },
    { href: "/app/channels", label: "Kênh", icon: Radio },
    { href: "/app/brand", label: "Bộ nhận diện", icon: Palette },
    ...(admin ? [{ href: "/admin", label: "Admin", icon: ShieldCheck }] : []),
  ];
}

function isActive(pathname: string, item: Item) {
  if (item.href === "/app") return pathname === "/app" || pathname.startsWith("/app/projects");
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

/** The section an `/app` path belongs to (the top bar names it). */
export function currentAppItem(pathname: string, admin: boolean) {
  return appNavItems(admin).find((item) => isActive(pathname, item));
}

/** Icon rail (`sm` and up). The admin area is reached from the top bar's segmented control, so it has no tile here. */
export function AppNav() {
  const pathname = usePathname();
  const [projects, publications, channels, brand] = appNavItems(false);
  return <NavRail label="Chính" homeHref="/app" groups={[[projects], [publications, channels], [brand]]} isActive={(item) => isActive(pathname, item)} />;
}

/**
 * Phone navigation: a fixed bottom tab bar (thumb reach), hidden on the editor
 * where the screen belongs to the timeline and its own toolbar.
 */
export function MobileNav({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  if (/^\/app\/projects\/[^/]+\/edit/.test(pathname)) return null;
  const items = appNavItems(admin);
  return (
    <nav aria-label="Chính" className="fixed inset-x-0 bottom-0 z-40 border-t bg-sidebar/95 backdrop-blur supports-[backdrop-filter]:bg-sidebar/85 sm:hidden pb-safe">
      <ul className="flex items-stretch">
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground", active && "text-foreground")}
              >
                <span className={cn("flex h-8 w-11 items-center justify-center rounded-lg transition-colors", active && "bg-sidebar-accent shadow-xs ring-1 ring-sidebar-border")}>
                  <item.icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
