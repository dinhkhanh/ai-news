import Link from "next/link";
import { AppNav, MobileNav } from "@/components/app-nav";
import { UserMenu } from "@/components/user-menu";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const impersonated = Boolean((session.session as { impersonatedBy?: string | null }).impersonatedBy);
  const admin = session.user.role === "admin";
  return (
    <div className="flex min-h-screen flex-col">
      {impersonated ? (
        <div className="bg-amber-400 px-4 py-1 text-center text-xs font-medium text-black">
          You are impersonating {session.user.email}. Every action is logged.
        </div>
      ) : null}
      {/* Sticky, except on pages that mount their own <StickyToolbar>, which flags <html data-own-bar>. */}
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 [html[data-own-bar]_&]:static">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-6">
          <Link href="/app" className="inline-flex h-10 items-center gap-2 rounded-lg px-1.5 font-semibold tracking-tight" aria-label="ai-news, trang dự án">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden>
              ai
            </span>
            <span>ai-news</span>
          </Link>
          <AppNav admin={admin} />
          <div className="ml-auto">
            <UserMenu name={session.user.name} email={session.user.email} impersonated={impersonated} />
          </div>
        </div>
      </header>
      {/* Bottom padding on phones leaves room for the tab bar; `pb-safe` in the bar itself handles the home indicator. */}
      <main className="flex-1 px-3 pt-4 pb-24 sm:px-6 sm:pt-6 sm:pb-8">{children}</main>
      <MobileNav admin={admin} />
    </div>
  );
}
