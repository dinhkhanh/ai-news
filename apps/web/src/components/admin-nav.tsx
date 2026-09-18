"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const ADMIN_NAV = [
  ["/admin", "Overview"],
  ["/admin/users", "Users"],
  ["/admin/domains", "Domains"],
  ["/admin/workspaces", "Workspaces"],
  ["/admin/integrations", "Integrations"],
  ["/admin/channels", "Channels"],
  ["/admin/analytics", "Analytics"],
  ["/admin/prompts", "Prompt templates"],
  ["/admin/evals", "Eval set & runs"],
  ["/admin/music", "Music library"],
  ["/admin/quotas", "Quotas"],
  ["/admin/activity", "Activity log"],
  ["/admin/health", "Health & test render"],
] as const;

/** Admin sections: a sidebar list on large screens, a horizontally scrolling chip row under the header on smaller ones. */
export function AdminNav({ variant }: { variant: "sidebar" | "strip" }) {
  const pathname = usePathname();
  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));
  if (variant === "strip") {
    return (
      <nav aria-label="Admin" className="flex gap-1 overflow-x-auto px-3 py-2 scrollbar-none">
        {ADMIN_NAV.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            aria-current={active(href) ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:h-10",
              active(href) && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label="Admin" className="mt-6 flex flex-col gap-0.5 text-sm">
      {ADMIN_NAV.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={active(href) ? "page" : undefined}
          className={cn(
            "rounded-lg px-2.5 py-2 font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            active(href) && "bg-sidebar-accent text-primary shadow-xs ring-1 ring-border",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
