"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Palette, Radio, Send, ShieldCheck, type LucideIcon } from "lucide-react";
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

/** Header links (desktop and tablet): icon + label, the current section in blue. */
export function AppNav({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Chính" className="hidden items-center gap-1 sm:flex">
      {appNavItems(admin).map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
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
    <nav aria-label="Chính" className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:hidden pb-safe">
      <ul className="flex items-stretch">
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground", active && "text-primary")}
              >
                <span className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", active && "bg-primary/12")}>
                  <item.icon className="size-5" aria-hidden />
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
