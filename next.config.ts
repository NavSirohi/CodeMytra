import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // ─── Turbopack Root Resolution ─────────────────────────────────────────────
  // Explicitly anchors project root to avoid parent workspace/monorepo resolution bugs
  turbopack: {
    root: path.resolve(__dirname),
  },

  // ─── Security Headers ──────────────────────────────────────────────────────
  // Applied to all routes. Tightened for the CodeMytra platform.
  // E2B sandbox iframes are served from *.e2b.app — allowed in frame-src only.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },

  // ─── Vercel / Serverless Function Limits ──────────────────────────────────
  // Long-running generation is handled by Inngest (outside request handling).
  // Normal Next.js routes keep a short timeout to stay within Vercel free tier.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],

  // ─── Image Optimisation ───────────────────────────────────────────────────
  images: {
    remotePatterns: [
      // Clerk avatar images
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "images.clerk.dev" },
    ],
  },
};

export default nextConfig;
