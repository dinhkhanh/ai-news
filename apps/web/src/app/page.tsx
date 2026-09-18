import { redirect } from "next/navigation";
import { LogoMark } from "@/components/logo-mark";
import { GoogleSignIn } from "@/components/google-sign-in";
import { getSession } from "@/lib/session";
import { safeNextPath } from "@/lib/url";

export default async function Home({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const session = await getSession();
  const { next, error } = await searchParams;
  if (session) redirect(safeNextPath(next));
  return (
    <main className="flex flex-1 items-center justify-center bg-sidebar p-4 sm:p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-card p-6 shadow-xs ring-1 ring-border sm:p-8">
        <div className="space-y-2">
          <LogoMark className="size-8" />
          <h1 className="text-2xl font-medium tracking-tight">ai-news</h1>
          <p className="text-sm text-muted-foreground">Bài báo → video dọc ngắn → Reels, TikTok, Shorts.</p>
        </div>
        <GoogleSignIn next={next} />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <p className="text-xs text-muted-foreground">Chỉ dành cho tài khoản Google Workspace được phê duyệt.</p>
      </div>
    </main>
  );
}
