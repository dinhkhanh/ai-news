import Link from "next/link";
import { AdminNav } from "@/components/admin-nav";
import { UserMenu } from "@/components/user-menu";
import { requireAdmin } from "@/lib/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar p-4 lg:block">
        <Link href="/app" className="inline-flex h-10 items-center gap-2 rounded-lg px-1.5 text-sm font-semibold">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden>
            ai
          </span>
          ai-news <span className="font-normal text-muted-foreground">/ admin</span>
        </Link>
        <AdminNav variant="sidebar" />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85">
          <div className="flex h-14 items-center gap-3 px-3 sm:px-6">
            <Link href="/app" className="inline-flex h-10 items-center gap-2 rounded-lg px-1.5 text-sm font-semibold lg:hidden">
              <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden>
                ai
              </span>
              admin
            </Link>
            <div className="ml-auto">
              <UserMenu name={session.user.name} email={session.user.email} />
            </div>
          </div>
          <div className="border-t lg:hidden">
            <AdminNav variant="strip" />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-3 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
