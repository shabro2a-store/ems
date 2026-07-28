'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiSend, errorMessage } from '@/lib/api';
import { Card, CardBody, Alert } from '@/components/ui';
import DriverAlarm from '@/components/field/DriverAlarm';
import EnableAlerts from '@/components/field/EnableAlerts';

type Status =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ready'; lat: number; lng: number; accuracy: number }
  | { kind: 'error'; message: string };

interface TripInfo { open: boolean; since_min?: number; threshold_min: number }

function dur(min: number): string {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export default function DriverHomeClient({ username, branch }: { username: string; branch: { name: string; gps_radius_m: number; gps_accuracy_max_m: number; trip_threshold_min: number } }) {
  const [trip, setTrip] = useState<TripInfo | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const fetchTrip = useCallback(async () => {
    const r = await apiGet<TripInfo>('/api/me/trip/current');
    if (r.ok) setTrip(r.data);
  }, []);

  useEffect(() => {
    fetchTrip();
    const id = setInterval(fetchTrip, 30_000);
    return () => clearInterval(id);
  }, [fetchTrip]);

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

  const submit = useCallback(async (endpoint: '/api/me/trip/start' | '/api/me/trip/end') => {
    if (status.kind !== 'ready') { setBanner({ tone: 'danger', text: 'Tap "Get GPS" first.' }); return; }
    setBusy(true); setBanner(null);
    const r = await apiSend<{ duration_min?: number }>(endpoint, {
      idempotent: true, idemPrefix: 'trip',
      body: { lat: status.lat, lng: status.lng, accuracy: status.accuracy },
    });
    setBusy(false);
    if (r.ok) {
      setBanner({ tone: 'success', text: endpoint.endsWith('start') ? 'Trip started. Drive safe!' : `Back! Trip lasted ${dur(r.data.duration_min ?? 0)}.` });
      await fetchTrip();
    } else setBanner({ tone: 'danger', text: errorMessage(r) });
  }, [status, fetchTrip]);

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

      <Card className={over ? 'border-warning/40' : ''}>
        <CardBody className="text-center">
          {open ? (
            <>
              <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${over ? 'bg-warning-subtle text-warning' : 'bg-primary-subtle text-primary'}`}>
                <span className={`h-2 w-2 rounded-full ${over ? 'bg-warning' : 'bg-primary'}`} /> On a trip
              </div>
              <p className="mt-2 text-3xl font-semibold tabular">{dur(since)}</p>
              <p className="text-xs text-muted">out · threshold {branch.trip_threshold_min}m{over ? ' · over' : ''}</p>
            </>
          ) : (
            <>
              <div className="inline-flex items-center gap-2 rounded-full bg-surface-muted px-3 py-1 text-sm font-medium text-muted">
                <span className="h-2 w-2 rounded-full bg-muted" /> Not on a trip
              </div>
              <p className="mt-2 text-sm text-muted">Tap OUT when you leave on a delivery.</p>
            </>
          )}
        </CardBody>
      </Card>

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
        onClick={() => submit(open ? '/api/me/trip/end' : '/api/me/trip/start')}
        disabled={busy || !ready}
        className={`h-32 w-full rounded-2xl text-2xl font-bold text-white shadow-sm transition-colors disabled:opacity-40 ${open ? 'bg-primary hover:bg-primary-hover' : 'bg-warning hover:brightness-95'}`}
      >
        {busy ? 'Please wait…' : open ? 'BACK' : 'OUT'}
      </button>

      <p className="text-center text-xs text-muted">
        Start and end trips at {branch.name} (within {branch.gps_radius_m}m).
      </p>
    </div>
  );
}
