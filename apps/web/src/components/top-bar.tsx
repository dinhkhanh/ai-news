"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { currentAdminItem } from "@/components/admin-nav";
import { currentAppItem } from "@/components/app-nav";
import { LogoMark } from "@/components/logo-mark";
import { SegmentedLinks } from "@/components/ui/segmented";

/** One level up from a nested page: the editor goes back to its project, everything else to its section. */
function parentOf(pathname: string, sectionHref: string) {
  const edit = pathname.match(/^(\/app\/projects\/[^/]+)\/edit/);
  if (edit) return edit[1];
  return pathname === sectionHref ? null : sectionHref;
}

/**
 * The bar at the top of the white panel, as in the reference: back chevron (on nested
 * pages), where you are, the area switch as a segmented control (platform admins),
 * and the account menu (`children`) on the right.
 *
 * It sticks, except on pages that mount their own <StickyToolbar>, which flags
 * <html data-own-bar>. The wrapper is painted in the rail colour so nothing shows
 * through the panel's rounded corner while the page scrolls under it.
 */
export function TopBar({ area, admin, children }: { area: "app" | "admin"; admin: boolean; children?: React.ReactNode }) {
  const pathname = usePathname();
  const item = area === "admin" ? currentAdminItem(pathname) : currentAppItem(pathname, false);
  const back = item ? parentOf(pathname, item.href) : null;
  return (
    <header className="sticky top-0 z-40 bg-sidebar sm:pt-2 [html[data-own-bar]_&]:static">
      <div className="flex h-14 items-center gap-2 border-b bg-card px-3 sm:gap-4 sm:rounded-tl-2xl sm:border-t sm:border-l sm:px-5">
        <Link href="/app" aria-label="ai-news" className="flex size-10 items-center justify-center rounded-lg sm:hidden">
          <LogoMark />
        </Link>
        {back ? (
          <Link href={back} aria-label="Quay lại" className="-mx-1 flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground pointer-coarse:size-11">
            <ChevronLeft className="size-5" strokeWidth={1.75} aria-hidden />
          </Link>
        ) : null}
        <span className="min-w-0 truncate text-[0.9375rem] font-medium sm:text-base">{item?.label ?? "ai-news"}</span>
        {admin ? (
          <SegmentedLinks
            label="Khu vực"
            className="hidden sm:inline-flex"
            options={[
              { href: "/app", label: "Ứng dụng", active: area === "app" },
              { href: "/admin", label: "Admin", active: area === "admin" },
            ]}
          />
        ) : null}
        <div className="ml-auto">{children}</div>
      </div>
    </header>
  );
}
