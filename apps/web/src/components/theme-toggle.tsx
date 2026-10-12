"use client";
import { useTheme } from "next-themes";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";

/**
 * The top bar's one-tap switch: flips between light and dark (an explicit choice, which then
 * stops following the system). Which icon shows is decided by the `.dark` class in CSS, not by
 * React state, so the server render and the first client render agree.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      type="button"
      aria-label="Đổi giao diện sáng / tối"
      title="Giao diện sáng / tối"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 pointer-coarse:size-11"
    >
      <MoonIcon className="size-[18px] dark:hidden" strokeWidth={1.75} aria-hidden />
      <SunIcon className="hidden size-[18px] dark:block" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

const THEMES = [
  { value: "light", label: "Sáng", icon: SunIcon },
  { value: "dark", label: "Tối", icon: MoonIcon },
  { value: "system", label: "Theo hệ thống", icon: MonitorIcon },
] as const;

/** The account menu's full choice, including going back to following the system. */
export function ThemeMenuGroup() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-xs">Giao diện</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(value) => setTheme(String(value))}>
        {THEMES.map((t) => (
          <DropdownMenuRadioItem key={t.value} value={t.value} className="min-h-10">
            <t.icon aria-hidden /> {t.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
