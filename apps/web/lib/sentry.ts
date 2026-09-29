import * as Sentry from '@sentry/nextjs';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  if (!process.env.SENTRY_DSN) return;
  if (process.env.NODE_ENV !== 'production') return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Errors only. Every route is wrapped, and the field screens poll every few
    // seconds, so sampled traces would spend a free plan's quota on requests
    // that worked.
    tracesSampleRate: 0,
    environment: process.env.NODE_ENV,
  });
  initialized = true;
}
