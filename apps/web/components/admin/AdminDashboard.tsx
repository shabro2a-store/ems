'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend, centsToUsd, formatBeirutTime } from '@/lib/api';
import { Card, CardBody, CardHeader, Badge, StatTile, EmptyState, Spinner, Select, Button } from '@/components/ui';

interface Person {
  id: string;
  username: string;
  role: string;
  branch_name: string | null;
  status: 'IN' | 'ON_TRIP' | 'DAY_OFF' | 'ABSENT';
  since_min: number;
  over: boolean;
  hours_today: number;
  trips_today: number | null;
}
interface Overview {
  branches: { id: string; name: string }[];
  branchId: string;
  kpis: { present: number; absent: number; driversOut: number; driversOver: number; tripsToday: number; hoursToday: number; laborTodayCent: number };
  people: Person[];
  attention: {
    lateDrivers: { trip_id: string; driver_username: string; branch_name: string; since_min: number; threshold_min: number }[];
    flags: { id: string; kind: string; username: string | null; branch_name: string | null; created_at: string; notified_at: string | null }[];
    pendingAdvances: { id: string; username: string; amount_cent: number; reason: string | null }[];
    pendingLeaves: { id: string; username: string; kind: string; start_date: string; end_date: string; note: string | null }[];
  };
}
interface TrendPoint { date: string; label: string; present: number; hours: number }
type ActivityEvent = { id: string; type: 'IN' | 'OUT' | 'TRIP_OUT' | 'TRIP_BACK'; username: string; at: string };

const POLL_MS = 10_000;

function dur(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

const STATUS: Record<Person['status'], { label: (p: Person) => string; tone: 'success' | 'primary' | 'danger' | 'warning' | 'neutral' }> = {
  IN: { label: (p) => `In · ${dur(p.since_min)}`, tone: 'success' },
  ON_TRIP: { label: (p) => `On trip · ${dur(p.since_min)}${p.over ? ' over' : ''}`, tone: 'warning' },
  DAY_OFF: { label: () => 'Day off', tone: 'neutral' },
  ABSENT: { label: () => 'Absent', tone: 'danger' },
};

export default function AdminDashboard() {
  const [branchId, setBranchId] = useState('all');
  const [ov, setOv] = useState<Overview | null>(null);
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const branchRef = useRef(branchId);
  branchRef.current = branchId;

  const loadOverview = useCallback(async () => {
    const r = await apiGet<Overview>(`/api/admin/overview?branchId=${branchRef.current}`);
    if (r.ok) {
      setOv(r.data);
      setUpdated(new Date());
    }
  }, []);

  const loadAux = useCallback(async () => {
    const [a, t] = await Promise.all([
      apiGet<{ events: ActivityEvent[] }>(`/api/admin/activity?branchId=${branchRef.current}&limit=20`),
      apiGet<{ points: TrendPoint[] }>(`/api/admin/trends?branchId=${branchRef.current}&days=7`),
    ]);
    if (a.ok) setActivity(a.data.events);
    if (t.ok) setTrends(t.data.points);
  }, []);

  useEffect(() => {
    loadOverview();
    loadAux();
    const id = setInterval(loadOverview, POLL_MS);
    return () => clearInterval(id);
  }, [branchId, loadOverview, loadAux]);

  async function act(id: string, url: string, body?: unknown) {
    setBusy(id);
    await apiSend(url, { body, idempotent: true, idemPrefix: 'dash' });
    await Promise.all([loadOverview(), loadAux()]);
    setBusy(null);
  }

  if (!ov) {
    return (
      <div className="grid place-items-center py-24 text-muted">
        <Spinner />
      </div>
    );
  }

  const k = ov.kpis;
  const att = ov.attention;
  const attentionCount =
    att.lateDrivers.length + att.flags.length + att.pendingAdvances.length + att.pendingLeaves.length;
  const maxPresent = Math.max(1, ...trends.map((p) => p.present));
  const hoursWeek = Math.round(trends.reduce((s, p) => s + p.hours, 0) * 10) / 10;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">Live operations across your branches</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {updated ? `Updated ${updated.toLocaleTimeString()}` : 'Live'}
          </span>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
            <option value="all">All branches</option>
            {ov.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Present now" value={k.present} tone="success" />
        <StatTile label="Absent" value={k.absent} tone={k.absent > 0 ? 'danger' : 'neutral'} />
        <StatTile
          label="Drivers out"
          value={k.driversOut}
          tone={k.driversOver > 0 ? 'warning' : 'neutral'}
          hint={k.driversOver > 0 ? `${k.driversOver} over threshold` : undefined}
        />
        <StatTile label="Trips today" value={k.tripsToday} hint="orders delivered" />
        <StatTile label="Hours today" value={k.hoursToday} hint={`≈ ${centsToUsd(k.laborTodayCent)} labor`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* LEFT */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Who's in right now" subtitle={`${ov.people.length} staff`} />
            {ov.people.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">No staff in this view.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {ov.people.map((p) => {
                  const s = STATUS[p.status];
                  return (
                    <li key={p.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                      <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-surface-muted text-xs font-semibold text-muted">
                        {initials(p.username)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{p.username}</div>
                        <div className="text-xs text-muted">{p.branch_name ?? '—'}</div>
                      </div>
                      <Badge tone={p.status === 'ON_TRIP' && p.over ? 'warning' : s.tone}>{s.label(p)}</Badge>
                      {p.trips_today !== null && (
                        <span className="tabular w-12 text-right text-xs text-muted" title="trips today">🚚 {p.trips_today}</span>
                      )}
                      <span className="tabular w-14 text-right text-xs text-muted">
                        {p.hours_today > 0 ? `${p.hours_today}h` : '—'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="This week" subtitle="Present staff per day" />
            <CardBody>
              <div className="mb-4 flex gap-6 text-sm">
                <div>
                  <div className="text-xs text-muted">Hours this week</div>
                  <div className="tabular text-xl font-semibold">{hoursWeek}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Peak present</div>
                  <div className="tabular text-xl font-semibold">{Math.max(0, ...trends.map((p) => p.present))}</div>
                </div>
              </div>
              <div className="flex h-24 items-end gap-2">
                {trends.map((p, i) => (
                  <div key={p.date} className="flex flex-1 flex-col items-center gap-1.5">
                    <div
                      className={`w-full max-w-[34px] rounded-t ${i === trends.length - 1 ? 'bg-primary' : 'bg-primary/70'}`}
                      style={{ height: `${Math.max(4, (p.present / maxPresent) * 100)}%` }}
                      title={`${p.present} present · ${p.hours}h`}
                    />
                    <span className="text-[11px] text-muted">{p.label}</span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Needs attention" subtitle={`${attentionCount} item${attentionCount === 1 ? '' : 's'}`} />
            {attentionCount === 0 ? (
              <CardBody>
                <EmptyState title="All clear" hint="Nothing needs your attention right now." />
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {att.lateDrivers.map((d) => (
                  <li key={d.trip_id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="warning">Late</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{d.driver_username} is {dur(d.since_min)} out</div>
                      <div className="text-xs text-muted">{d.branch_name} · threshold {d.threshold_min}m</div>
                    </div>
                  </li>
                ))}
                {att.flags.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="danger">Flag</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{f.username ?? 'Employee'} · {f.kind.replace(/_/g, ' ').toLowerCase()}</div>
                      <div className="text-xs text-muted">{f.branch_name ?? '—'} · {formatBeirutTime(f.created_at)}</div>
                      <div className="mt-2">
                        <Button size="sm" variant="secondary" loading={busy === f.id} onClick={() => act(f.id, `/api/admin/flags/${f.id}/resolve`)}>
                          Resolve
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
                {att.pendingAdvances.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="primary">Advance</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{a.username} requested {centsToUsd(a.amount_cent)}</div>
                      {a.reason && <div className="text-xs text-muted">{a.reason}</div>}
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="success" loading={busy === a.id} onClick={() => act(a.id, `/api/admin/advances/${a.id}/decision`, { decision: 'APPROVED' })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="secondary" loading={busy === a.id} onClick={() => act(a.id, `/api/admin/advances/${a.id}/decision`, { decision: 'REJECTED' })}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
                {att.pendingLeaves.map((l) => (
                  <li key={l.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="primary">Leave</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{l.username} · {l.kind.replace(/_/g, ' ').toLowerCase()}</div>
                      <div className="text-xs text-muted">
                        {l.start_date}{l.end_date !== l.start_date ? ` → ${l.end_date}` : ''}{l.note ? ` · ${l.note}` : ''}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="success" loading={busy === l.id} onClick={() => act(l.id, `/api/admin/leave/${l.id}/decision`, { decision: 'APPROVED' })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="secondary" loading={busy === l.id} onClick={() => act(l.id, `/api/admin/leave/${l.id}/decision`, { decision: 'REJECTED' })}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Activity" subtitle="Latest events" />
            {activity.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">No recent activity.</p>
              </CardBody>
            ) : (
              <ul className="max-h-72 overflow-y-auto py-1">
                {activity.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2 sm:px-5">
                    <span className={`h-2 w-2 flex-none rounded-full ${ACT_DOT[e.type]}`} />
                    <span className="flex-1 text-sm">
                      <span className="font-medium">{e.username}</span> {ACT_TEXT[e.type]}
                    </span>
                    <span className="tabular text-xs text-muted">{formatBeirutTime(e.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

const ACT_DOT: Record<ActivityEvent['type'], string> = {
  IN: 'bg-success',
  OUT: 'bg-muted',
  TRIP_OUT: 'bg-primary',
  TRIP_BACK: 'bg-primary/50',
};
const ACT_TEXT: Record<ActivityEvent['type'], string> = {
  IN: 'checked in',
  OUT: 'checked out',
  TRIP_OUT: 'left on a trip',
  TRIP_BACK: 'returned from a trip',
};
