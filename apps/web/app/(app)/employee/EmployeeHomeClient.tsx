'use client';

import { useEffect, useState, useCallback } from 'react';
import PunchButton from '@/components/PunchButton';

interface TodayPayload {
  in_at: string | null;
  minutes_since_in: number | null;
  earned_today_cent: number;
  earned_month_cent: number;
  approved_advance_balance_cent: number;
  net_cent: number;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ready'; lat: number; lng: number; accuracy: number }
  | { kind: 'error'; message: string };

function deviceFp(): string {
  if (typeof window === 'undefined') return 'ssr';
  let v = window.localStorage.getItem('ems_device_fp');
  if (!v) {
    v = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    window.localStorage.setItem('ems_device_fp', v);
  }
  return v;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

export default function EmployeeHomeClient({ branch }: { branch: { name: string; gps_radius_m: number; gps_accuracy_max_m: number } }) {
  const [today, setToday] = useState<TodayPayload | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const fetchToday = useCallback(async () => {
    try {
      const r = await fetch('/api/me/today', { credentials: 'include' });
      const j = await r.json();
      if (j.ok) setToday(j.data);
    } catch {
    }
  }, []);

  useEffect(() => {
    fetchToday();
    const id = setInterval(fetchToday, 30_000);
    return () => clearInterval(id);
  }, [fetchToday]);

  useEffect(() => {
    if (today?.in_at) {
      const start = new Date(today.in_at).getTime();
      const tick = Math.floor((Date.now() - start) / 60_000);
      setToday((prev) => (prev ? { ...prev, minutes_since_in: Math.max(0, tick) } : prev));
    }
  }, [today?.in_at]);

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus({ kind: 'error', message: 'Geolocation not available on this device' });
      return;
    }
    setStatus({ kind: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy;
        if (accuracy > branch.gps_accuracy_max_m) {
          setStatus({
            kind: 'error',
            message: `GPS weak (${Math.round(accuracy)}m > ${branch.gps_accuracy_max_m}m). Step outside and retry.`,
          });
          return;
        }
        setStatus({
          kind: 'ready',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy,
        });
      },
      (err) => setStatus({ kind: 'error', message: err.message || 'Geolocation failed' }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }, [branch.gps_accuracy_max_m]);

  const submit = useCallback(
    async (kind: 'IN' | 'OUT') => {
      if (status.kind !== 'ready') {
        setBanner('Tap "Get GPS" first.');
        return;
      }
      setBusy(true);
      setBanner(null);
      try {
        const csrf = csrfFromCookie();
        const r = await fetch('/api/me/punch', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key':
              (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
            'X-CSRF-Token': csrf ?? '',
          },
          body: JSON.stringify({
            kind,
            lat: status.lat,
            lng: status.lng,
            accuracy: status.accuracy,
            deviceFp: deviceFp(),
          }),
        });
        const j = await r.json();
        if (j.ok) {
          setBanner(`Checked ${kind === 'IN' ? 'in' : 'out'}.`);
          await fetchToday();
        } else {
          setBanner(`Error: ${j.error?.code ?? 'UNKNOWN'} — ${j.error?.message ?? ''}`);
        }
      } catch (e) {
        setBanner(`Network error: ${e instanceof Error ? e.message : 'unknown'}`);
      } finally {
        setBusy(false);
      }
    },
    [status, fetchToday],
  );

  const devPunch = useCallback(
    async (kind: 'IN' | 'OUT') => {
      setBusy(true);
      setBanner(null);
      try {
        const csrf = csrfFromCookie();
        const r = await fetch('/api/me/punch/dev', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key':
              `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            'X-CSRF-Token': csrf ?? '',
          },
          body: JSON.stringify({ kind }),
        });
        const j = await r.json();
        if (j.ok) {
          setBanner(`[DEV] ${kind === 'IN' ? 'Checked in' : 'Checked out'} (no GPS).`);
          await fetchToday();
        } else {
          setBanner(`[DEV] Error: ${j.error?.code ?? 'UNKNOWN'} — ${j.error?.message ?? ''}`);
        }
      } catch (e) {
        setBanner(`[DEV] Network error: ${e instanceof Error ? e.message : 'unknown'}`);
      } finally {
        setBusy(false);
      }
    },
    [fetchToday],
  );

  const isIn = Boolean(today?.in_at);

  return (
    <main className="p-4 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Employee — {branch.name}</h1>

      {banner && (
        <div className="mb-3 p-3 rounded bg-gray-100 text-sm" role="status">
          {banner}
        </div>
      )}

      {today?.in_at && (
        <div className="mb-3 p-3 rounded bg-green-50 border border-green-200 text-green-900 text-sm">
          Currently IN since {new Date(today.in_at).toLocaleTimeString()} — {today.minutes_since_in ?? 0} min
        </div>
      )}

      <section className="mb-4">
        <p className="text-sm text-gray-600 mb-1">Status</p>
        <p className="text-base">
          {status.kind === 'idle' && 'GPS not acquired yet.'}
          {status.kind === 'locating' && 'Acquiring GPS...'}
          {status.kind === 'ready' && `GPS ready (±${Math.round(status.accuracy)}m).`}
          {status.kind === 'error' && <span className="text-red-700">{status.message}</span>}
        </p>
        <button
          type="button"
          onClick={locate}
          disabled={status.kind === 'locating'}
          className="mt-2 min-h-[56px] px-4 py-2 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-50"
        >
          {status.kind === 'locating' ? 'Locating...' : 'Get GPS'}
        </button>
      </section>

      <PunchButton
        isIn={isIn}
        disabled={busy || status.kind !== 'ready'}
        onPunch={submit}
      />

      <p className="mt-6 text-xs text-gray-500">
        Branch radius {branch.gps_radius_m}m. GPS must be within radius and accuracy ≤ {branch.gps_accuracy_max_m}m.
      </p>

      {/* Dev-only bypass: visible only when NEXT_PUBLIC_ENABLE_DEV_ENDPOINTS=true.
          In dev (laptop), this is true by default. In production, set to false. */}
      {process.env.NEXT_PUBLIC_ENABLE_DEV_ENDPOINTS === 'true' && (
        <div className="mt-4 p-3 rounded border border-dashed border-amber-300 bg-amber-50 text-xs">
          <div className="font-semibold text-amber-900 mb-1">Dev bypass (laptop only)</div>
          <div className="text-amber-800 mb-2">
            Skips GPS + geofence. Punches recorded at branch center. Use only for
            testing on a machine without GPS (like this laptop).
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => devPunch('IN')}
              className="flex-1 min-h-[44px] rounded bg-amber-600 text-white px-3 py-2 text-sm disabled:opacity-50"
            >
              Dev IN
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => devPunch('OUT')}
              className="flex-1 min-h-[44px] rounded bg-amber-700 text-white px-3 py-2 text-sm disabled:opacity-50"
            >
              Dev OUT
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
