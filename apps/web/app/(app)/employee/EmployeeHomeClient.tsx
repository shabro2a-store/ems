'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiSend, errorMessage, formatBeirutTime } from '@/lib/api';
import { Card, CardBody, StatTile, Alert } from '@/components/ui';

interface TodayPayload {
  in_at: string | null;
  minutes_since_in: number | null;
  minutes_today: number;
  hours_month: number;
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
    v = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem('ems_device_fp', v);
  }
  return v;
}
function dur(min: number): string {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export default function EmployeeHomeClient({ username, branch }: { username: string; branch: { name: string; gps_radius_m: number; gps_accuracy_max_m: number } }) {
  const [today, setToday] = useState<TodayPayload | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const fetchToday = useCallback(async () => {
    const r = await apiGet<TodayPayload>('/api/me/today');
    if (r.ok) setToday(r.data);
  }, []);

  useEffect(() => {
    fetchToday();
    const id = setInterval(fetchToday, 30_000);
    return () => clearInterval(id);
  }, [fetchToday]);

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
          setStatus({ kind: 'error', message: `GPS is weak (±${Math.round(accuracy)}m). Step outside and try again.` });
          return;
        }
        setStatus({ kind: 'ready', lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy });
      },
      (err) => setStatus({ kind: 'error', message: err.message || 'Could not get your location.' }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }, [branch.gps_accuracy_max_m]);

  const submit = useCallback(async (kind: 'IN' | 'OUT') => {
    if (status.kind !== 'ready') { setBanner({ tone: 'danger', text: 'Tap "Get GPS" first.' }); return; }
    setBusy(true); setBanner(null);
    const r = await apiSend('/api/me/punch', {
      idempotent: true, idemPrefix: 'punch',
      body: { kind, lat: status.lat, lng: status.lng, accuracy: status.accuracy, deviceFp: deviceFp() },
    });
    setBusy(false);
    if (r.ok) { setBanner({ tone: 'success', text: kind === 'IN' ? 'Checked in. Have a good shift!' : 'Checked out. See you next time!' }); await fetchToday(); }
    else setBanner({ tone: 'danger', text: errorMessage(r) });
  }, [status, fetchToday]);

  const devPunch = useCallback(async (kind: 'IN' | 'OUT') => {
    setBusy(true); setBanner(null);
    const r = await apiSend('/api/me/punch/dev', { idempotent: true, idemPrefix: 'dev', body: { kind } });
    setBusy(false);
    if (r.ok) { setBanner({ tone: 'success', text: `[DEV] Checked ${kind === 'IN' ? 'in' : 'out'} (no GPS).` }); await fetchToday(); }
    else setBanner({ tone: 'danger', text: errorMessage(r) });
  }, [fetchToday]);

  const isIn = Boolean(today?.in_at);
  const ready = status.kind === 'ready';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Hi {username} 👋</h1>
        <p className="text-sm text-muted">{branch.name}</p>
      </div>

      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}

      <Card>
        <CardBody className="text-center">
          {isIn ? (
            <>
              <div className="inline-flex items-center gap-2 rounded-full bg-success-subtle px-3 py-1 text-sm font-medium text-success">
                <span className="h-2 w-2 rounded-full bg-success" /> Checked in
              </div>
              <p className="mt-2 text-sm text-muted">
                since {today && today.in_at ? formatBeirutTime(today.in_at) : '—'} · {dur(today?.minutes_since_in ?? 0)}
              </p>
            </>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-surface-muted px-3 py-1 text-sm font-medium text-muted">
              <span className="h-2 w-2 rounded-full bg-muted" /> Checked out
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Today" value={today ? dur(today.minutes_today) : '—'} />
        <StatTile label="This month" value={today ? `${today.hours_month.toFixed(1)}h` : '—'} />
      </div>

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

      <button
        onClick={() => submit(isIn ? 'OUT' : 'IN')}
        disabled={busy || !ready}
        aria-label={isIn ? 'Check out' : 'Check in'}
        className={`h-32 w-full rounded-2xl text-2xl font-bold text-white shadow-sm transition-colors disabled:opacity-40 ${isIn ? 'bg-danger hover:brightness-95' : 'bg-success hover:brightness-95'}`}
      >
        {busy ? 'Please wait…' : isIn ? 'CHECK OUT' : 'CHECK IN'}
      </button>

      <p className="text-center text-xs text-muted">
        You must be within {branch.gps_radius_m}m of {branch.name} with a good GPS signal.
      </p>

      {process.env.NEXT_PUBLIC_ENABLE_DEV_ENDPOINTS === 'true' && (
        <div className="rounded-xl border border-dashed border-warning/40 bg-warning-subtle p-3">
          <div className="mb-2 text-xs font-semibold text-warning">Dev bypass (testing without GPS)</div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => devPunch('IN')} className="h-11 flex-1 rounded-lg bg-warning text-sm font-medium text-white disabled:opacity-50">Dev IN</button>
            <button disabled={busy} onClick={() => devPunch('OUT')} className="h-11 flex-1 rounded-lg bg-warning/80 text-sm font-medium text-white disabled:opacity-50">Dev OUT</button>
          </div>
        </div>
      )}
    </div>
  );
}
