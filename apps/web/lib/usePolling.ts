'use client';

import { useEffect, useRef } from 'react';

/**
 * Call `fn` every `ms` while the page is visible. Hidden, the ticks are
 * skipped - nobody is looking, and a dashboard left open all night was a
 * request every ten seconds for nothing - and the moment the page is shown
 * again it refreshes at once rather than waiting out the interval.
 *
 * Not for the driver's siren, which must keep listening in the background.
 */
export function usePolling(fn: () => unknown, ms: number): void {
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void latest.current();
    };
    const onVisible = () => {
      if (!document.hidden) void latest.current();
    };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
}
