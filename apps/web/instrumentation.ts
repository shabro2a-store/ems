export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initSentry } = await import('@/lib/sentry');
  initSentry();
}
