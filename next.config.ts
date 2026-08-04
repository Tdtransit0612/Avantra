import type { NextConfig } from "next";

// Static security headers — applied via next.config.ts for all routes.
// Content-Security-Policy is intentionally absent here; it is generated
// dynamically per-request in src/lib/supabase/middleware.ts so it can carry
// a per-request nonce that eliminates 'unsafe-inline' from script-src.
const staticSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'X-XSS-Protection', value: '1; mode=block' },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: staticSecurityHeaders,
      },
    ]
  },
  images: {
    // Supabase Storage (signed doc/image URLs). Most doc rendering uses signed
    // URLs via <img>/DocImg, but allow next/image for any Supabase-hosted asset.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
        pathname: '/storage/v1/object/**',
      },
    ],
  },
}

export default nextConfig;
