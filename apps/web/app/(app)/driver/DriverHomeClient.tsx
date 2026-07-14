'use client';

import { useEffect, useState, useCallback } from 'react';

type Status =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ready'; lat: number; lng: number; accuracy: number }
  | { kind: 'error'; message: string };

interface TripInfo {
  open: boolean;
  since_min?: number;
  threshold_min: number;
}

function deviceFp(): string {
  if (typeof window === 'undefined') return 'ssr';
  let v = window.localStorage.getItem('ems_device_fp');
  if (!v) {
    v = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem('ems_device_fp', v);
  }
  return v;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function DriverHomeClient({ branch }: { branch: { name: string; gps_radius_m: number; gps_accuracy_max_m: number; trip_threshold_min: number } }) {
  const [trip, setTrip] = useState<TripInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const POLL_MS = 30_000;

  const fetchTrip = useCallback(async () => {
    try {
      const r = await fetch('/api/me/trip/current', { credentials: 'include' });
      const j = await r.json();
      if (j.ok) setTrip(j.data);
    } catch {
    }
  }, []);

  useEffect(() => {
    fetchTrip();
    const id = setInterval(fetchTrip, POLL_MS);
    return () => clearInterval(id);
  }, [fetchTrip]);

  useEffect(() => {
    if (trip?.open && trip.since_min !== undefined) {
      const tick = setInterval(() => {
        setTrip((prev) =>
          prev && prev.open && prev.since_min !== undefined
            ? { ...prev, since_min: prev.since_min + 1 }
            : prev,
        );
      }, 60_000);
      return () => clearInterval(tick);
    }
  }, [trip?.open, trip?.since_min]);

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus({ kind: 'error', message: 'Geolocation not available' });
      return;
    }
    setStatus({ kind: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy;
        if (accuracy > branch.gps_accuracy_max_m) {
          setStatus({ kind: 'error', message: `GPS weak (${Math.round(accuracy)}m > ${branch.gps_accuracy_max_m}m)` });
          return;
        }
        setStatus({ kind: 'ready', lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy });
      },
      (err) => setStatus({ kind: 'error', message: err.message || 'Geolocation failed' }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }, [branch.gps_accuracy_max_m]);

  const submit = useCallback(
    async (endpoint: '/api/me/trip/start' | '/api/me/trip/end') => {
      if (status.kind !== 'ready') {
        setBanner('Tap "Get GPS" first.');
        return;
      }
      setBusy(true);
      setBanner(null);
      try {
        const csrf = csrfFromCookie();
        const r = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idemKey(),
            'X-CSRF-Token': csrf ?? '',
          },
          body: JSON.stringify({
            lat: status.lat,
            lng: status.lng,
            accuracy: status.accuracy,
          }),
        });
        const j = await r.json();
        if (j.ok) {
          setBanner(endpoint === '/api/me/trip/start' ? `Trip started at ${j.data.out_at}` : `Trip ended. Duration ${j.data.duration_min} min`);
          await fetchTrip();
        } else {
          setBanner(`Error: ${j.error?.code ?? 'UNKNOWN'}`);
        }
      } catch (e) {
        setBanner(`Network error: ${e instanceof Error ? e.message : 'unknown'}`);
      } finally {
        setBusy(false);
      }
    },
    [status, fetchTrip],
  );

  const open = trip?.open ?? false;
  const overThreshold = open && (trip?.since_min ?? 0) > branch.trip_threshold_min;

  return (
    <main className="p-4 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Driver — {branch.name}</h1>

      {banner && (
        <div className="mb-3 p-3 rounded bg-gray-100 text-sm" role="status">
          {banner}
        </div>
      )}

      {open ? (
        <div className={`mb-3 p-3 rounded border text-sm ${overThreshold ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-blue-50 border-blue-200 text-blue-900'}`}>
          OUT since {trip?.since_min ?? 0} min (threshold {branch.trip_threshold_min} min)
        </div>
      ) : (
        <div className="mb-3 p-3 rounded bg-gray-50 border text-sm text-gray-700">No active trip.</div>
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

      {open ? (
        <button
          type="button"
          onClick={() => submit('/api/me/trip/end')}
          disabled={busy || status.kind !== 'ready'}
          className="w-full min-h-[80px] rounded bg-blue-600 hover:bg-blue-700 text-white text-xl font-semibold disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'BACK'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => submit('/api/me/trip/start')}
          disabled={busy || status.kind !== 'ready'}
          className="w-full min-h-[80px] rounded bg-orange-600 hover:bg-orange-700 text-white text-xl font-semibold disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'OUT'}
        </button>
      )}

      <p className="mt-6 text-xs text-gray-500">
        Branch radius {branch.gps_radius_m}m. GPS must be within radius and accuracy ≤ {branch.gps_accuracy_max_m}m.
      </p>
    </main>
  );
}