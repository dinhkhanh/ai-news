import { AppNav, MobileNav } from "@/components/app-nav";
import { TopBar } from "@/components/top-bar";
import { UserMenu } from "@/components/user-menu";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const impersonated = Boolean((session.session as { impersonatedBy?: string | null }).impersonatedBy);
  const admin = session.user.role === "admin";
  return (
    // The reference shell: a grey frame carrying the icon rail, and the page as a white panel inset into it.
    <div className="flex min-h-dvh flex-col bg-sidebar">
      {impersonated ? (
        <div className="bg-amber-400 px-4 py-1 text-center text-xs font-medium text-black">
          You are impersonating {session.user.email}. Every action is logged.
        </div>
      ) : null}
      <div className="flex flex-1">
        <AppNav />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar area="app" admin={admin}>
            <UserMenu name={session.user.name} email={session.user.email} impersonated={impersonated} />
          </TopBar>
          {/* Bottom padding on phones leaves room for the tab bar; `pb-safe` in the bar itself handles the home indicator. */}
          <main className="flex-1 overflow-x-clip bg-background px-3 pt-4 pb-24 sm:border-l sm:px-6 sm:pt-6 sm:pb-8">{children}</main>
        </div>
      </div>
      <MobileNav admin={admin} />
    </div>
  );
}
