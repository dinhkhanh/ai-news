import { redirect } from "next/navigation";
import { GoogleSignIn } from "@/components/google-sign-in";
import { getSession } from "@/lib/session";

export default async function Home({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const session = await getSession();
  const { next, error } = await searchParams;
  if (session) redirect(next && next.startsWith("/") ? next : "/app");
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">ai-news</h1>
          <p className="text-sm text-muted-foreground">Bài báo → video dọc ngắn → Reels, TikTok, Shorts.</p>
        </div>
        <GoogleSignIn next={next} />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <p className="text-xs text-muted-foreground">Chỉ dành cho tài khoản Google Workspace được phê duyệt.</p>
      </div>
    </main>
  );
}
