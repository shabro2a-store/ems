export function initSentry(): void {
  // Sentry is intentionally not wired in this commit.
  // Add `@sentry/nextjs` to apps/web/package.json, then replace this stub with:
  //
  //   import * as Sentry from '@sentry/nextjs';
  //   export function initSentry(): void {
  //     if (initialized) return;
  //     if (!process.env.SENTRY_DSN) return;
  //     if (process.env.NODE_ENV !== 'production') return;
  //     Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1, environment: process.env.NODE_ENV });
  //     initialized = true;
  //   }
  //
  // Justification: server-side error tracking per spec.md §3.11.
}
