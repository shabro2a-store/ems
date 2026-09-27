// Everything the app loads is its own: no CDN, no client-side analytics.
// 'unsafe-inline' for scripts because the App Router streams its hydration data
// as inline scripts (a nonce would force every page dynamic); the dev server
// also needs eval for fast refresh.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // The camera is the receipt photo, the location is the punch; nothing else.
  { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // output: 'standalone' disabled - causes EPERM symlink errors on Windows
  // and unnecessary complexity. The full build still works fine for our use case.
  experimental: {
    // Runs instrumentation.ts on server boot so Sentry also wraps API routes,
    // not just page rendering.
    instrumentationHook: true,
  },
  eslint: {
    // No ESLint config or dependency in this repo; skip the build-time step.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
