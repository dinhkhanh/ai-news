"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/url";

export function GoogleSignIn({ next }: { next?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="w-full"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const { error } = await authClient.signIn.social({
          provider: "google",
          callbackURL: safeNextPath(next),
          errorCallbackURL: "/?error=" + encodeURIComponent("Đăng nhập thất bại. Tài khoản hoặc tên miền chưa được phép."),
        });
        if (error) {
          toast.error(error.message ?? "Sign-in failed");
          setBusy(false);
        }
      }}
    >
      {busy ? "Đang chuyển hướng…" : "Đăng nhập bằng Google"}
    </Button>
  );
}
