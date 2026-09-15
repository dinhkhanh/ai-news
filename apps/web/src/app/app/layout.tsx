import Link from "next/link";
import { UserMenu } from "@/components/user-menu";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const impersonated = Boolean((session.session as { impersonatedBy?: string | null }).impersonatedBy);
  return (
    <div className="flex min-h-screen flex-col">
      {impersonated ? (
        <div className="bg-amber-500 px-4 py-1 text-center text-xs font-medium text-black">
          You are impersonating {session.user.email}. Every action is logged.
        </div>
      ) : null}
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/app" className="font-semibold">
            ai-news
          </Link>
          <Link href="/app" className="text-muted-foreground hover:text-foreground">
            Dự án
          </Link>
          {session.user.role === "admin" ? (
            <Link href="/admin" className="text-muted-foreground hover:text-foreground">
              Admin
            </Link>
          ) : null}
        </nav>
        <UserMenu name={session.user.name} email={session.user.email} impersonated={impersonated} />
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
