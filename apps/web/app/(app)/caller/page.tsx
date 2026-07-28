'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';

interface Driver {
  id: string;
  username: string;
  name: string;
  clocked_in: boolean;
  available: boolean;
  open_trip_since: string | null;
  trips_today: number;
  ringing: boolean;
}

function elapsed(sinceIso: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Available first (brightest), then out-on-order, then off-shift — the "lights
// off" metaphor: unavailable cards dim and sink to the bottom.
function rank(d: Driver): number {
  if (d.available) return 0;
  if (d.open_trip_since) return 1;
  return 2;
}

export default function CallerBoard() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => 0);
  const [justRang, setJustRang] = useState<Record<string, number>>({});
  const startedAt = useRef(0);

  const load = useCallback(async () => {
    const r = await apiGet<{ branch: string | null; drivers: Driver[] }>('/api/caller/drivers');
    if (r.ok) {
      setBranch(r.data.branch);
      setDrivers(r.data.drivers);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 3000);
    return () => clearInterval(poll);
  }, [load]);

  // Local clock for the live "out for" timers. Uses elapsed offset so we never
  // call Date.now() during render.
  useEffect(() => {
    startedAt.current = Date.now();
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function ring(d: Driver) {
    if (!d.available) return;
    setJustRang((p) => ({ ...p, [d.id]: Date.now() }));
    await apiSend('/api/caller/ring', { body: { driverId: d.id } });
    load();
    // clear the local "ringing…" flash after a few seconds
    setTimeout(() => setJustRang((p) => { const n = { ...p }; delete n[d.id]; return n; }), 6000);
  }

  async function logout() {
    await apiSend('/api/auth/logout');
    window.location.href = '/login';
  }

  const sorted = [...drivers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Drivers</h1>
          <p className="text-sm text-muted">{branch ?? 'Your branch'} · tap a driver to ring their phone</p>
        </div>
        <button onClick={logout} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface">
          Logout
        </button>
      </header>

      {loading ? (
        <p className="py-16 text-center text-muted">Loading…</p>
      ) : drivers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center text-muted">
          No drivers in this branch yet.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {sorted.map((d) => {
            const ringing = d.ringing || justRang[d.id] != null;
            const out = Boolean(d.open_trip_since);
            const tone = d.available
              ? 'border-success/40 bg-success-subtle text-content'
              : out
                ? 'border-warning/30 bg-warning-subtle text-content opacity-80'
                : 'border-border bg-surface text-muted opacity-55';
            return (
              <button
                key={d.id}
                onClick={() => ring(d)}
                disabled={!d.available}
                className={`relative flex min-h-[112px] flex-col justify-between rounded-2xl border p-4 text-left transition ${tone} ${
                  d.available ? 'shadow-card hover:-translate-y-0.5 hover:shadow-pop active:translate-y-0' : 'cursor-not-allowed'
                } ${ringing ? 'ring-4 ring-primary/50 animate-pulse' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-lg font-bold leading-tight">{d.name}</span>
                  <span className={`mt-1 h-2.5 w-2.5 flex-none rounded-full ${d.available ? 'bg-success' : out ? 'bg-warning' : 'bg-slate-300'}`} />
                </div>
                <div>
                  <div className="text-sm font-medium">
                    {ringing ? 'Ringing…' : d.available ? 'Available' : out ? `Out · ${elapsed(d.open_trip_since!, now)}` : 'Off shift'}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {d.trips_today} trip{d.trips_today === 1 ? '' : 's'} today
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
