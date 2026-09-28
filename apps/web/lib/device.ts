'use client';

/** A random id this phone keeps, sent with each punch so the owner can tell phones apart. */
export function deviceFp(): string {
  if (typeof window === 'undefined') return 'ssr';
  let v = window.localStorage.getItem('ems_device_fp');
  if (!v) {
    v = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem('ems_device_fp', v);
  }
  return v;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
