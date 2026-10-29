import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.SPESESMART_LAN_OPERATIONAL === "true" && process.env.SPESESMART_HOME_PRODUCTION !== "true" ? ".next-lan" : ".next",
  devIndicators: process.env.SPESESMART_LAN_OPERATIONAL === "true" ? false : undefined,
  // Next 16.4 otherwise suspends hydration waiting for debug data over HMR.
  // The restricted LAN gateway deliberately does not expose that WebSocket.
  experimental: process.env.SPESESMART_LAN_OPERATIONAL === "true" ? { reactDebugChannel: false } : {},
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
