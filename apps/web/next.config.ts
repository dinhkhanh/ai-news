import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-news/video"],
  // Logo uploads (brand kit, channel) go through server actions and may be up to 2 MB; the default cap is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
};

export default nextConfig;
