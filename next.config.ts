import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root — a stray package-lock.json in the user home dir
  // otherwise makes Turbopack guess the wrong root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
