'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend, errorMessage, formatBeirut, formatBeirutTime } from '@/lib/api';
import { PageHeader, Card, CardBody, Badge, Button, Modal, Field, Input, EmptyState, Alert, Spinner } from '@/components/ui';

type State = 'empty' | 'open' | 'confirmed' | 'expired' | 'month_closed';

interface Trip {
  id: string;
  out_at: string;
  back_at: string | null;
  branch: string;
  system_closed: boolean;
  receipt: 'available' | 'wiped' | 'none';
  denied_at: string | null;
  denied_reason: string | null;
  reviewed_at: string | null;
  locked: boolean;
}
interface DriverDay {
  driver_id: string;
  username: string;
  name: string | null;
  branch: string | null;
  date: string;
  state: State;
  deadline: string | null;
  count: number;
  denied: number;
  trips: Trip[];
}
interface Payload {
  date: string;
  today: string;
  drivers: DriverDay[];
  pending: Array<{ date: string; drivers: number }>;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const STATE_BADGE: Record<State, { tone: 'neutral' | 'primary' | 'success' | 'danger' | 'warning'; label: string }> = {
  empty: { tone: 'neutral', label: 'No trips' },
  open: { tone: 'warning', label: 'To review' },
  confirmed: { tone: 'success', label: 'Confirmed' },
  expired: { tone: 'neutral', label: 'Locked · 48h passed' },
  month_closed: { tone: 'neutral', label: 'Locked · month closed' },
};

export default function AdminTripsReviewPage() {
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ trip: Trip; driver: DriverDay } | null>(null);
  const [denyTarget, setDenyTarget] = useState<{ trip: Trip; driver: DriverDay } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(async (d: string | null) => {
    setLoading(true);
    setErr(null);
    const r = await apiGet<Payload>(`/api/admin/trips/review${d ? `?date=${d}` : ''}`);
    setLoading(false);
    if (!r.ok) { setErr(errorMessage(r)); return; }
    setData(r.data);
    setDate(r.data.date);
  }, []);

  useEffect(() => { load(null); }, [load]);

  async function setDenied(trip: Trip, deny: boolean, reason?: string) {
    setBusy(trip.id);
    setMsg(null);
    const r = await apiSend('/api/admin/trips/review/deny', { body: { tripId: trip.id, deny, reason } });
    setBusy(null);
    if (!r.ok) { setErr(errorMessage(r)); return; }
    setDenyTarget(null);
    setMsg(deny ? 'Trip denied. It will not be paid.' : 'Trip restored.');
    await load(date);
  }

  async function confirmDay(row: DriverDay) {
    if (armed !== row.driver_id) {
      setArmed(row.driver_id);
      window.setTimeout(() => setArmed((a) => (a === row.driver_id ? null : a)), 4000);
      return;
    }
    setArmed(null);
    setBusy(row.driver_id);
    setMsg(null);
    const r = await apiSend<{ confirmed: number }>('/api/admin/trips/review/confirm', { body: { driverId: row.driver_id, date: row.date } });
    setBusy(null);
    if (!r.ok) { setErr(errorMessage(r)); return; }
    setMsg(`${row.username}'s ${prettyDate(row.date)} confirmed: ${row.count} trip${row.count === 1 ? '' : 's'} paid${row.denied ? `, ${row.denied} denied` : ''}.`);
    await load(date);
  }

  const isToday = data ? data.date === data.today : false;

  return (
    <>
      <PageHeader
        title="Trips review"
        subtitle="Every delivery's receipt, one working day at a time. Deny anything that is not that day's receipt, then confirm the shift. A day not confirmed within 48 hours of its last trip is paid as it stands."
      />

      {err && <div className="mb-4"><Alert tone="danger">{err}</Alert></div>}
      {msg && <div className="mb-4"><Alert tone="success">{msg}</Alert></div>}

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => date && load(shiftDate(date, -1))} aria-label="Previous day">‹</Button>
            <Input
              type="date"
              value={date ?? ''}
              onChange={(e) => e.target.value && load(e.target.value)}
              className="w-44"
              aria-label="Working day"
            />
            <Button variant="secondary" size="sm" onClick={() => date && load(shiftDate(date, 1))} aria-label="Next day" disabled={isToday}>›</Button>
            {!isToday && <Button variant="ghost" size="sm" onClick={() => load(null)}>Today</Button>}
          </div>
          {data && data.pending.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Waiting for review:</span>
              {data.pending.map((p) => (
                <button
                  key={p.date}
                  type="button"
                  onClick={() => load(p.date)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${p.date === data.date ? 'border-warning bg-warning-subtle text-warning' : 'border-border hover:bg-surface-muted'}`}
                >
                  {prettyDate(p.date)} · {p.drivers} driver{p.drivers === 1 ? '' : 's'}
                </button>
              ))}
            </div>
          ) : data ? (
            <span className="text-sm text-muted">Nothing waiting for review.</span>
          ) : null}
        </CardBody>
      </Card>

      {loading && !data ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : data && data.drivers.length === 0 ? (
        <EmptyState title={`No deliveries on ${prettyDate(data.date)}`} hint="No driver went out on an order on this working day." />
      ) : data ? (
        <div className="space-y-4">
          {data.drivers.map((row) => {
            const badge = STATE_BADGE[row.state];
            const open = row.state === 'open';
            return (
              <Card key={row.driver_id}>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{row.name || row.username}</span>
                        {row.name && <span className="text-sm text-muted">{row.username}</span>}
                        {row.branch && <span className="text-sm text-muted">· {row.branch}</span>}
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                      <div className="mt-0.5 text-sm text-muted">
                        {row.count} trip{row.count === 1 ? '' : 's'}
                        {row.denied > 0 && <span className="text-danger"> · {row.denied} denied</span>}
                        {open && row.deadline && <> · review until {formatBeirut(row.deadline, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</>}
                      </div>
                    </div>
                    {open && (
                      <Button
                        variant={armed === row.driver_id ? 'danger' : 'success'}
                        size="sm"
                        loading={busy === row.driver_id}
                        onClick={() => confirmDay(row)}
                      >
                        {armed === row.driver_id ? 'Tap again to confirm & lock' : 'Confirm shift'}
                      </Button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {row.trips.map((t, i) => {
                      const denied = Boolean(t.denied_at);
                      return (
                        <div
                          key={t.id}
                          className={`overflow-hidden rounded-xl border ${denied ? 'border-danger/40 opacity-70' : 'border-border'} bg-surface`}
                        >
                          <button
                            type="button"
                            onClick={() => t.receipt === 'available' && setPhoto({ trip: t, driver: row })}
                            className="relative block aspect-[3/4] w-full bg-surface-muted"
                            aria-label={`Receipt of trip ${i + 1}`}
                          >
                            {t.receipt === 'available' ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={`/api/admin/trips/${t.id}/receipt`}
                                alt={`Receipt, trip ${i + 1}`}
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <span className="grid h-full w-full place-items-center px-2 text-center text-xs text-muted">
                                {t.receipt === 'wiped' ? 'Photo wiped (older than a week)' : 'No photo — before receipts'}
                              </span>
                            )}
                            <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">#{i + 1}</span>
                            {denied && <span className="absolute right-1.5 top-1.5 rounded-md bg-danger px-1.5 py-0.5 text-xs font-semibold text-white">Denied</span>}
                          </button>
                          <div className="space-y-1 p-2 text-xs">
                            <div className="tabular font-medium">
                              {formatBeirutTime(t.out_at)} → {t.back_at ? formatBeirutTime(t.back_at) : 'still out'}
                            </div>
                            <div className="text-muted">
                              {t.branch}
                              {t.system_closed && <span className="text-warning"> · closed by system</span>}
                            </div>
                            {denied && t.denied_reason && <div className="text-danger">{t.denied_reason}</div>}
                            {t.locked ? (
                              <div className="text-muted">{t.reviewed_at ? 'Confirmed' : 'Locked'}</div>
                            ) : denied ? (
                              <Button variant="secondary" size="sm" fullWidth loading={busy === t.id} onClick={() => setDenied(t, false)}>
                                Restore
                              </Button>
                            ) : (
                              <Button variant="danger" size="sm" fullWidth loading={busy === t.id} onClick={() => setDenyTarget({ trip: t, driver: row })}>
                                Deny
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      ) : null}

      {photo && (
        <PhotoModal
          trip={photo.trip}
          driver={photo.driver}
          onClose={() => setPhoto(null)}
          onDeny={!photo.trip.locked && !photo.trip.denied_at ? () => { setDenyTarget(photo); setPhoto(null); } : undefined}
        />
      )}
      {denyTarget && (
        <DenyModal
          trip={denyTarget.trip}
          driver={denyTarget.driver}
          busy={busy === denyTarget.trip.id}
          onClose={() => setDenyTarget(null)}
          onDeny={(reason) => setDenied(denyTarget.trip, true, reason)}
        />
      )}
    </>
  );
}

function PhotoModal({ trip, driver, onClose, onDeny }: { trip: Trip; driver: DriverDay; onClose: () => void; onDeny?: () => void }) {
  return (
    <Modal
      size="lg"
      title={`${driver.username} · ${formatBeirut(trip.out_at, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
      onClose={onClose}
      footer={
        <>
          {onDeny && <Button variant="danger" onClick={onDeny}>Deny this trip</Button>}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-muted">
        Out {formatBeirutTime(trip.out_at)} → {trip.back_at ? formatBeirutTime(trip.back_at) : 'still out'} · {trip.branch}. Check the date and time printed on the receipt against this.
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/admin/trips/${trip.id}/receipt`} alt="Receipt" className="mx-auto max-h-[70vh] w-auto rounded-lg" />
    </Modal>
  );
}

function DenyModal({ trip, driver, busy, onClose, onDeny }: { trip: Trip; driver: DriverDay; busy: boolean; onClose: () => void; onDeny: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={`Deny trip · ${driver.username}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={() => onDeny(reason)}>Deny — not paid</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        The trip at {formatBeirutTime(trip.out_at)} will not be paid and will not count as one of {driver.username}&apos;s deliveries. You can restore it until the shift is confirmed.
      </p>
      <Field label="Reason (optional)" htmlFor="deny-reason">
        <Input id="deny-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. receipt dated yesterday" />
      </Field>
    </Modal>
  );
}
