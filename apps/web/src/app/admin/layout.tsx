import { AdminNav } from "@/components/admin-nav";
import { TopBar } from "@/components/top-bar";
import { UserMenu } from "@/components/user-menu";
import { requireAdmin } from "@/lib/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  return (
    // Same shell as /app: grey frame + icon rail, the page as a white inset panel.
    <div className="flex min-h-dvh bg-sidebar">
      <AdminNav variant="rail" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar area="admin" admin>
          <UserMenu name={session.user.name} email={session.user.email} />
        </TopBar>
        <AdminNav variant="strip" />
        <main className="min-w-0 flex-1 overflow-x-clip bg-background p-3 sm:border-l sm:p-6">{children}</main>
      </div>
    </div>
  );
}
