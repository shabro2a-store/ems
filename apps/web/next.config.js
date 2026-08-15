/** @type {import('next').NextConfig} */
const nextConfig = {
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
