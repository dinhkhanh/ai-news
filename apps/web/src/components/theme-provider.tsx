"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Light / dark / system, stored per browser (`localStorage.theme`). next-themes puts `.dark` on
 * <html> before first paint (so `globals.css` swaps the tokens without a flash) and sets
 * `color-scheme`, so native selects, scrollbars and date pickers follow.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
