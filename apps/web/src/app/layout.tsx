import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

// The reference typeface. The UI is Vietnamese, so the `vietnamese` subset is not optional.
const inter = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "ai-news", template: "%s · ai-news" },
  description: "News article to short vertical video",
};

// `viewport-fit=cover` lets sticky bars pad for the home indicator / notch (safe-area insets in globals.css).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${inter.variable} h-full font-sans antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors position="top-right" />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
