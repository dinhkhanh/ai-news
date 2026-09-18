"use client";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, LogOutIcon, UserRoundXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/** Account menu: an avatar button (name beside it from `sm` up) opening sign-out and, when impersonating, the way back. */
export function UserMenu({ name, email, impersonated }: { name: string; email: string; impersonated?: boolean }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-10 gap-2 rounded-full pr-2 pl-1 pointer-coarse:h-11" aria-label={`Tài khoản ${name}`} />}>
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground" aria-hidden>
          {initials(name) || "?"}
        </span>
        <span className="hidden max-w-32 truncate text-sm font-normal sm:inline">{name}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="space-y-0.5 py-1.5">
            <div className="text-sm font-medium text-foreground">{name}</div>
            <div className="truncate text-xs font-normal">{email}</div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {impersonated ? (
          <DropdownMenuItem
            className="min-h-10"
            onClick={async () => {
              await authClient.admin.stopImpersonating();
              router.push("/admin/users");
              router.refresh();
            }}
          >
            <UserRoundXIcon /> Stop impersonating
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="min-h-10"
          onClick={async () => {
            await authClient.signOut();
            router.push("/");
            router.refresh();
          }}
        >
          <LogOutIcon /> Đăng xuất
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
