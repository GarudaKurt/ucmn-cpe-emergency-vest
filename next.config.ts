import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
    serverExternalPackages: ["web-push"],  // ✅ Add this

};

export default nextConfig;
