import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["drizzle-orm", "postgres"],
  },
};

export default nextConfig;
