"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, ChartColumn, FlaskConical, Gauge, Globe, HeartPulse, LayoutDashboard, MessageSquareText, Music, Plug, Radio, ScrollText, Users } from "lucide-react";
import { NavRail, type RailItem } from "@/components/nav-rail";
import { cn } from "@/lib/utils";

/** Admin sections in rail groups: overview · people · connections · content · operations. */
export const ADMIN_NAV_GROUPS: RailItem[][] = [
  [{ href: "/admin", label: "Overview", icon: LayoutDashboard }],
  [
    { href: "/admin/users", label: "Users", icon: Users },
    { href: "/admin/domains", label: "Domains", icon: Globe },
    { href: "/admin/workspaces", label: "Workspaces", icon: Building2 },
  ],
  [
    { href: "/admin/integrations", label: "Integrations", icon: Plug },
    { href: "/admin/channels", label: "Channels", icon: Radio },
    { href: "/admin/analytics", label: "Analytics", icon: ChartColumn },
  ],
  [
    { href: "/admin/prompts", label: "Prompt templates", icon: MessageSquareText },
    { href: "/admin/evals", label: "Eval set & runs", icon: FlaskConical },
    { href: "/admin/music", label: "Music library", icon: Music },
  ],
  [
    { href: "/admin/quotas", label: "Quotas", icon: Gauge },
    { href: "/admin/activity", label: "Activity log", icon: ScrollText },
    { href: "/admin/health", label: "Health & test render", icon: HeartPulse },
  ],
];

export const ADMIN_NAV = ADMIN_NAV_GROUPS.flat();

const isActive = (pathname: string, href: string) => (href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(href + "/"));

/** The section an `/admin` path belongs to (the top bar names it). */
export function currentAdminItem(pathname: string) {
  return ADMIN_NAV.find((item) => isActive(pathname, item.href));
}

/** Admin sections: the icon rail from `sm` up, a horizontally scrolling chip row under the top bar on phones. */
export function AdminNav({ variant }: { variant: "rail" | "strip" }) {
  const pathname = usePathname();
  if (variant === "rail") {
    return <NavRail label="Admin" homeHref="/app" groups={ADMIN_NAV_GROUPS} isActive={(item) => isActive(pathname, item.href)} />;
  }
  return (
    <nav aria-label="Admin" className="flex gap-1 overflow-x-auto border-b bg-card px-3 py-2 scrollbar-none sm:hidden">
      {ADMIN_NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:h-10",
              active && "bg-muted font-medium text-foreground hover:bg-muted",
            )}
          >
            <item.icon className="size-4" strokeWidth={1.75} aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
