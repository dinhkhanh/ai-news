import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-news/video"],
  // Logo uploads (brand kit, channel) go through server actions and may be up to 2 MB; the default cap is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No page of this app is meant to be framed: approve / publish / admin buttons must not be clickjacked.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
