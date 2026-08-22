'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiSend, errorMessage, formatBeirutTime } from '@/lib/api';
import { Card, CardBody, StatTile, Alert } from '@/components/ui';
import DriverAlarm from '@/components/field/DriverAlarm';
import EnableAlerts from '@/components/field/EnableAlerts';

interface TodayPayload {
  in_at: string | null;
  minutes_since_in: number | null;
  minutes_today: number;
  hours_month: number;
}
interface TripInfo { open: boolean; since_min?: number; threshold_min: number }
type Status =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ready'; lat: number; lng: number; accuracy: number }
  | { kind: 'error'; message: string };

function deviceFp(): string {
  if (typeof window === 'undefined') return 'ssr';
  let v = window.localStorage.getItem('ems_device_fp');
  if (!v) {
    v = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem('ems_device_fp', v);
  }
  return v;
}
function dur(min: number): string {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export default function DriverHomeClient({ username, branch }: { username: string; branch: { name: string; gps_radius_m: number; gps_accuracy_max_m: number; trip_threshold_min: number } }) {
  const [today, setToday] = useState<TodayPayload | null>(null);
  const [trip, setTrip] = useState<TripInfo | null>(null);
  const [canGoOut, setCanGoOut] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [t, tr, calls] = await Promise.all([
      apiGet<TodayPayload>('/api/me/today'),
      apiGet<TripInfo>('/api/me/trip/current'),
      apiGet<{ ringing: boolean; canGoOut: boolean }>('/api/me/calls'),
    ]);
    if (t.ok) setToday(t.data);
    if (tr.ok) setTrip(tr.data);
    if (calls.ok) setCanGoOut(calls.data.canGoOut);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Fast poll for dispatch state so "out on order" enables right after the ring.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await apiGet<{ canGoOut: boolean }>('/api/me/calls');
      if (alive && r.ok) setCanGoOut(r.data.canGoOut);
    };
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus({ kind: 'error', message: 'Location not available on this device.' });
      return;
    }
    setStatus({ kind: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy;
        if (accuracy > branch.gps_accuracy_max_m) {
          setStatus({ kind: 'error', message: `GPS is weak (±${Math.round(accuracy)}m). Move to open sky and try again.` });
          return;
        }
        setStatus({ kind: 'ready', lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy });
      },
      (err) => setStatus({ kind: 'error', message: err.message || 'Could not get your location.' }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }, [branch.gps_accuracy_max_m]);

  const punch = useCallback(async (kind: 'IN' | 'OUT') => {
    if (status.kind !== 'ready') { setBanner({ tone: 'danger', text: 'Tap "Get GPS" first.' }); return; }
    setBusy(true); setBanner(null);
    const r = await apiSend('/api/me/punch', {
      idempotent: true, idemPrefix: 'punch',
      body: { kind, lat: status.lat, lng: status.lng, accuracy: status.accuracy, deviceFp: deviceFp() },
    });
    setBusy(false);
    if (r.ok) { setBanner({ tone: 'success', text: kind === 'IN' ? 'Clocked in. Have a good shift!' : 'Clocked out. See you next time!' }); await refresh(); }
    else setBanner({ tone: 'danger', text: errorMessage(r) });
  }, [status, refresh]);

  const tripSubmit = useCallback(async (endpoint: '/api/me/trip/start' | '/api/me/trip/end') => {
    if (status.kind !== 'ready') { setBanner({ tone: 'danger', text: 'Tap "Get GPS" first.' }); return; }
    setBusy(true); setBanner(null);
    const r = await apiSend<{ duration_min?: number }>(endpoint, {
      idempotent: true, idemPrefix: 'trip',
      body: { lat: status.lat, lng: status.lng, accuracy: status.accuracy },
    });
    setBusy(false);
    if (r.ok) {
      setBanner({ tone: 'success', text: endpoint.endsWith('start') ? 'Out on an order. Drive safe!' : `Back! Trip lasted ${dur(r.data.duration_min ?? 0)}.` });
      await refresh();
    } else setBanner({ tone: 'danger', text: errorMessage(r) });
  }, [status, refresh]);

  const devPunch = useCallback(async (kind: 'IN' | 'OUT') => {
    setBusy(true); setBanner(null);
    const r = await apiSend('/api/me/punch/dev', { idempotent: true, idemPrefix: 'dev', body: { kind } });
    setBusy(false);
    if (r.ok) { setBanner({ tone: 'success', text: `[DEV] Clocked ${kind === 'IN' ? 'in' : 'out'} (no GPS).` }); await refresh(); }
    else setBanner({ tone: 'danger', text: errorMessage(r) });
  }, [refresh]);

  const isIn = Boolean(today?.in_at);
  const open = trip?.open ?? false;
  const since = trip?.since_min ?? 0;
  const over = open && since > branch.trip_threshold_min;
  const ready = status.kind === 'ready';

  return (
    <div className="space-y-4">
      <DriverAlarm />
      <div>
        <h1 className="text-xl font-semibold">Hi {username} 🚚</h1>
        <p className="text-sm text-muted">{branch.name}</p>
      </div>
      <EnableAlerts />

      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}

      {/* Shift (attendance clock) */}
      <Card>
        <CardBody className="text-center">
          {isIn ? (
            <>
              <div className="inline-flex items-center gap-2 rounded-full bg-success-subtle px-3 py-1 text-sm font-medium text-success">
                <span className="h-2 w-2 rounded-full bg-success" /> On shift
              </div>
              <p className="mt-2 text-sm text-muted">
                since {today?.in_at ? formatBeirutTime(today.in_at) : '—'} · {dur(today?.minutes_since_in ?? 0)}
              </p>
            </>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-surface-muted px-3 py-1 text-sm font-medium text-muted">
              <span className="h-2 w-2 rounded-full bg-muted" /> Off shift
            </div>
          )}
        </CardBody>
      </Card>

      {/* Three tiles on a 375px phone: "1h 55m" at tile size does not fit a
          third of the row, so the month spans instead of squeezing. */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="On shift" value={today ? dur(today.in_at ? (today.minutes_since_in ?? 0) : 0) : '—'} />
        <StatTile label="Today" value={today ? dur(today.minutes_today) : '—'} />
        <div className="col-span-2">
          <StatTile label="This month" value={today ? `${today.hours_month.toFixed(1)}h` : '—'} />
        </div>
      </div>

      {/* Trip status */}
      <Card className={over ? 'border-warning/40' : ''}>
        <CardBody className="text-center">
          {open ? (
            <>
              <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${over ? 'bg-warning-subtle text-warning' : 'bg-primary-subtle text-primary'}`}>
                <span className={`h-2 w-2 rounded-full ${over ? 'bg-warning' : 'bg-primary'}`} /> Out on an order
              </div>
              <p className="mt-2 text-3xl font-semibold tabular">{dur(since)}</p>
              <p className="text-xs text-muted">out · threshold {branch.trip_threshold_min}m{over ? ' · over' : ''}</p>
            </>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-surface-muted px-3 py-1 text-sm font-medium text-muted">
              <span className="h-2 w-2 rounded-full bg-muted" /> Not on an order
            </div>
          )}
        </CardBody>
      </Card>

      {/* Shared GPS */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Location</span>
            <span className="text-xs text-muted">
              {status.kind === 'idle' && 'Not checked yet'}
              {status.kind === 'locating' && 'Getting GPS…'}
              {status.kind === 'ready' && `Ready · ±${Math.round(status.accuracy)}m`}
              {status.kind === 'error' && <span className="text-danger">Weak signal</span>}
            </span>
          </div>
          {status.kind === 'error' && <Alert tone="danger">{status.message}</Alert>}
          <button
            onClick={locate}
            disabled={status.kind === 'locating'}
            className="h-12 w-full rounded-lg border border-border bg-surface font-medium text-content hover:bg-surface-muted disabled:opacity-50"
          >
            {status.kind === 'locating' ? 'Getting GPS…' : ready ? '✓ GPS ready — refresh' : 'Get GPS'}
          </button>
        </CardBody>
      </Card>

      {/* Attendance clock button */}
      <div>
        <button
          onClick={() => punch(isIn ? 'OUT' : 'IN')}
          disabled={busy || !ready || (isIn && open)}
          aria-label={isIn ? 'Clock out' : 'Clock in'}
          className={`h-20 w-full rounded-2xl text-xl font-bold text-white shadow-sm transition-colors disabled:opacity-40 ${isIn ? 'bg-danger hover:brightness-95' : 'bg-success hover:brightness-95'}`}
        >
          {busy ? 'Please wait…' : isIn ? 'CLOCK OUT' : 'CLOCK IN'}
        </button>
        {isIn && open && (
          <p className="mt-1.5 text-center text-xs text-muted">End your order before clocking out.</p>
        )}
      </div>

      {/* Trip button — going out requires the counter to have rung you first */}
      <div>
        <button
          onClick={() => tripSubmit(open ? '/api/me/trip/end' : '/api/me/trip/start')}
          disabled={busy || !ready || (!open && (!isIn || !canGoOut))}
          className={`h-28 w-full rounded-2xl text-2xl font-bold text-white shadow-sm transition-colors disabled:opacity-40 ${open ? 'bg-primary hover:bg-primary-hover' : 'bg-warning hover:brightness-95'}`}
        >
          {busy ? 'Please wait…' : open ? 'BACK' : 'OUT ON ORDER'}
        </button>
        <p className="mt-1.5 text-center text-xs text-muted">
          {open
            ? `Tap BACK at ${branch.name} when you return (within ${branch.gps_radius_m}m).`
            : !isIn
              ? 'Clock in first to go out on orders.'
              : !canGoOut
                ? '⏳ Waiting for the counter to call you — you can go out once they ring.'
                : `📞 You've been called. Head out, then tap BACK when you return.`}
        </p>
      </div>

      {process.env.NEXT_PUBLIC_ENABLE_DEV_ENDPOINTS === 'true' && (
        <div className="rounded-xl border border-dashed border-warning/40 bg-warning-subtle p-3">
          <div className="mb-2 text-xs font-semibold text-warning">Dev bypass (clock without GPS)</div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => devPunch('IN')} className="h-11 flex-1 rounded-lg bg-warning text-sm font-medium text-white disabled:opacity-50">Dev IN</button>
            <button disabled={busy} onClick={() => devPunch('OUT')} className="h-11 flex-1 rounded-lg bg-warning/80 text-sm font-medium text-white disabled:opacity-50">Dev OUT</button>
          </div>
        </div>
      )}
    </div>
  );
}
