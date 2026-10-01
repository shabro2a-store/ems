import * as Sentry from '@sentry/nextjs';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initSentry } = await import('@/lib/sentry');
  initSentry();
}

// Every error a route handler or server component lets escape. A no-op until
// initSentry() has run with a DSN.
export const onRequestError = Sentry.captureRequestError;
