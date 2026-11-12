import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  async rewrites() {
    return {
      // A `text/plain` document hides the <link rel="icon"> from the browser, so
      // it asks for the default path. Without this, every raw view logs a 404.
      beforeFiles: [{ source: "/favicon.ico", destination: "/icon.png" }],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // A shared link carries its key in the fragment. Never leak it in a Referer.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
