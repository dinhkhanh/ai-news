import Link from "next/link";
import { UserMenu } from "@/components/user-menu";
import { requireAdmin } from "@/lib/session";

const nav = [
  ["/admin", "Overview"],
  ["/admin/users", "Users"],
  ["/admin/domains", "Domains"],
  ["/admin/workspaces", "Workspaces"],
  ["/admin/integrations", "Integrations"],
  ["/admin/prompts", "Prompt templates"],
  ["/admin/evals", "Eval set & runs"],
  ["/admin/quotas", "Quotas"],
  ["/admin/activity", "Activity log"],
  ["/admin/health", "Health & test render"],
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r bg-sidebar p-4">
        <Link href="/app" className="block text-sm font-semibold">
          ai-news <span className="text-muted-foreground">/ admin</span>
        </Link>
        <nav className="mt-6 flex flex-col gap-1 text-sm">
          {nav.map(([href, label]) => (
            <Link key={href} href={href} className="rounded-md px-2 py-1.5 hover:bg-sidebar-accent">
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end border-b px-6 py-3">
          <UserMenu name={session.user.name} email={session.user.email} />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
