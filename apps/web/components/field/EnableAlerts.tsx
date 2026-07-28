'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';

type State = 'hidden' | 'prompt' | 'denied' | 'ios-install' | 'error';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

// Sets up Web Push on the driver's device so a ring reaches a locked/closed phone.
// The in-app alarm works regardless; this only adds the background case.
export default function EnableAlerts() {
  const [state, setState] = useState<State>('hidden');

  async function subscribe(): Promise<boolean> {
    const keyRes = await apiGet<{ publicKey: string | null }>('/api/me/push/key');
    if (!keyRes.ok || !keyRes.data.publicKey) return false; // push not configured server-side
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey) as BufferSource,
      });
    }
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    const res = await apiSend('/api/me/push/subscribe', {
      body: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    });
    return res.ok;
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!supported) {
        // iPhone Safari before "Add to Home Screen" has no PushManager.
        if (isIos() && !isStandalone()) setState('ios-install');
        return;
      }
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch {
        return;
      }
      if (!alive) return;
      if (Notification.permission === 'granted') {
        await subscribe();
        setState('hidden');
      } else if (Notification.permission === 'denied') {
        setState('denied');
      } else {
        setState('prompt');
      }
    })();
    return () => { alive = false; };
  }, []);

  async function enable() {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      const ok = await subscribe();
      setState(ok ? 'hidden' : 'error');
    } else {
      setState('denied');
    }
  }

  if (state === 'hidden') return null;

  const base = 'rounded-xl border px-4 py-3 text-sm';
  if (state === 'prompt') {
    return (
      <div className={`${base} border-primary/30 bg-primary-subtle`}>
        <div className="flex items-center justify-between gap-3">
          <span>🔔 Turn on order alerts so you ring even when your phone is locked.</span>
          <button onClick={enable} className="flex-none rounded-lg bg-primary px-3 py-1.5 font-semibold text-white">
            Enable
          </button>
        </div>
      </div>
    );
  }
  if (state === 'ios-install') {
    return (
      <div className={`${base} border-warning/30 bg-warning-subtle`}>
        📲 To get alerts when your phone is locked: tap <b>Share</b> → <b>Add to Home Screen</b>, then open the app from your home screen.
      </div>
    );
  }
  if (state === 'denied') {
    return (
      <div className={`${base} border-warning/30 bg-warning-subtle`}>
        🔕 Notifications are blocked. Enable them for this site in your phone settings to get order alerts when the app is closed.
      </div>
    );
  }
  return (
    <div className={`${base} border-danger/30 bg-danger-subtle`}>
      Couldn&apos;t set up alerts. You&apos;ll still be alarmed while the app is open.
    </div>
  );
}
