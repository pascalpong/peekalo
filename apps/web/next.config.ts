import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // The separately packaged maintenance runner uses the same SDK at runtime.
  serverExternalPackages: ["@supabase/supabase-js"],
  // Next traces ESM entrypoints; the maintenance artifact requires the pinned
  // SDK's CJS entrypoints and its small dependency closure as well.
  outputFileTracingIncludes: {
    "/api/health": [
      "../../node_modules/.pnpm/@supabase+*/**",
      "../../node_modules/.pnpm/iceberg-js@*/**",
      "../../node_modules/.pnpm/tslib@*/**",
    ],
  },
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@peekalo/contracts", "@peekalo/design", "@peekalo/reveal", "@peekalo/web-ui"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/auth/:path*", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }] },
      ...["/u/:path*", "/operator/:path*", "/safety", "/support", "/privacy", "/terms", "/delete-account"].map(source => ({ source, headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }] })),
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
