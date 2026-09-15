"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function UserMenu({ name, email, impersonated }: { name: string; email: string; impersonated?: boolean }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="text-right leading-tight">
        <div className="font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{email}</div>
      </div>
      {impersonated ? (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await authClient.admin.stopImpersonating();
            router.push("/admin/users");
            router.refresh();
          }}
        >
          Stop impersonating
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          await authClient.signOut();
          router.push("/");
          router.refresh();
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
