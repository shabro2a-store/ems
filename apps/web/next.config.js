const { withSentryConfig } = require('@sentry/nextjs/config');

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
};

// An error that escapes a route handler or a server component reaches Sentry
// through Next's own onRequestError hook (instrumentation.ts): the build is
// Turbopack, where Sentry wraps nothing at build time. With SENTRY_DSN unset
// the hook does nothing. No source maps are uploaded (no auth token, no
// release) and the plugin sends no telemetry of its own. The browser is not
// reported - there is no client SDK (the CSP allows no third-party connection),
// so the global-error.js notice does not apply.
process.env.SENTRY_SUPPRESS_GLOBAL_ERROR_HANDLER_FILE_WARNING = '1';
module.exports = withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  sourcemaps: { disable: true },
  release: { create: false },
});
