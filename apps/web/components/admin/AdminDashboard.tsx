'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiSend, centsToUsd, formatBeirutTime, errorMessage } from '@/lib/api';
import { Card, CardBody, CardHeader, Badge, StatTile, EmptyState, Spinner, Select, Button, Alert } from '@/components/ui';
import { TelegramAlertsCard } from './TelegramAlertsCard';

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
    flags: { id: string; kind: string; username: string | null; branch_name: string | null; created_at: string; notified_at: string | null; reason: string }[];
    penalties: { user_id: string; username: string; date: string; kind: 'SHORTFALL'; minutes: number; hours: number; amount_cent: number }[];
    overtime: { user_id: string; username: string; date: string; overtimeMin: number; amount_cent: number }[];
    pendingAdvances: { id: string; username: string; amount_cent: number; reason: string | null }[];
    pendingLeaves: { id: string; username: string; kind: string; start_date: string; end_date: string; off_min: number | null; note: string | null }[];
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
function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
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

  // `key` is per-button (id + action) so only the clicked button shows a spinner.
  // `success` may read the response so the confirmation can name what actually
  // changed — approving a leave writes schedule overrides the admin never sees
  // from here, and "done" alone reads as if the button did nothing.
  async function act(
    key: string,
    url: string,
    opts: { body?: unknown; success: string | ((data: unknown) => string) },
  ) {
    setBusy(key);
    setMsg(null);
    setConfirming(null);
    const res = await apiSend(url, { body: opts.body, idempotent: true, idemPrefix: 'dash' });
    await Promise.all([loadOverview(), loadAux()]);
    setBusy(null);
    setMsg(
      res.ok
        ? {
            tone: 'success',
            text: typeof opts.success === 'function' ? opts.success(res.data) : opts.success,
          }
        : { tone: 'danger', text: errorMessage(res) },
    );
  }

  // Approve/reject are final — the endpoints answer ALREADY_DECIDED on a second
  // attempt — so a misclick on Reject cannot be walked back. First click arms
  // the button, second click commits.
  async function reject(key: string, url: string, what: string) {
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    setConfirming(null);
    await act(key, url, { body: { decision: 'REJECTED' }, success: `${what} rejected.` });
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
    att.lateDrivers.length +
    att.flags.length +
    att.penalties.length +
    att.overtime.length +
    att.pendingAdvances.length +
    att.pendingLeaves.length;
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
            {msg && (
              <div className="px-4 pt-3 sm:px-5">
                <Alert tone={msg.tone}>{msg.text}</Alert>
              </div>
            )}
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
                      <div className="mt-1 text-xs text-muted">Clears itself when the driver presses Back — nothing to action here.</div>
                    </div>
                  </li>
                ))}
                {att.flags.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="danger">Flag</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{f.username ?? 'Employee'} · {f.kind.replace(/_/g, ' ').toLowerCase()}</div>
                      <div className="mt-0.5 text-sm">{f.reason}</div>
                      <div className="mt-1 text-xs text-muted">
                        {f.branch_name ?? '—'} · flagged {formatBeirutTime(f.created_at)}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {f.kind === 'MISSED_CHECKOUT'
                          ? 'Dismissing only clears this notice. If the punch itself is wrong, correct it in Punches.'
                          : 'Dismissing only clears this notice — no record is changed.'}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `flag:${f.id}`}
                          onClick={() => act(`flag:${f.id}`, `/api/admin/flags/${f.id}/resolve`, { success: 'Notice dismissed. No punch or pay record was changed.' })}
                        >
                          Dismiss
                        </Button>
                        {f.kind === 'MISSED_CHECKOUT' && (
                          <Button size="sm" variant="ghost" onClick={() => { window.location.href = '/admin/punches'; }}>
                            Fix punch
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
                {att.penalties.map((p) => {
                  const key = `${p.user_id}|${p.date}|${p.kind}`;
                  const body = { userId: p.user_id, date: p.date, kind: p.kind };
                  return (
                    <li key={key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                      <Badge tone="danger">Penalty</Badge>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="font-medium">
                          {p.username} · {centsToUsd(p.amount_cent)} docked
                        </div>
                        <div className="text-xs text-muted">
                          {p.date} · short {formatMinutes(p.minutes)} · {p.hours}h docked
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          Already applied. Accept to file it, or revoke it if they gave notice.
                        </div>
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === `pen-ok:${key}`}
                            onClick={() =>
                              act(`pen-ok:${key}`, '/api/admin/penalties/ack', {
                                body,
                                success: `Penalty for ${p.username} stands — ${centsToUsd(p.amount_cent)} stays docked.`,
                              })
                            }
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant={confirming === `pen-no:${key}` ? 'danger' : 'ghost'}
                            loading={busy === `pen-no:${key}`}
                            onClick={() => {
                              if (confirming !== `pen-no:${key}`) {
                                setConfirming(`pen-no:${key}`);
                                return;
                              }
                              void act(`pen-no:${key}`, '/api/admin/penalties/waive', {
                                body: { ...body, waived: true },
                                success: `Penalty revoked — ${centsToUsd(p.amount_cent)} returned to ${p.username}'s pay.`,
                              });
                            }}
                          >
                            {confirming === `pen-no:${key}` ? 'Tap again to confirm' : 'Revoke'}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
                {att.overtime.map((o) => {
                  const key = `${o.user_id}|${o.date}`;
                  const body = { userId: o.user_id, date: o.date };
                  return (
                    <li key={key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                      <Badge tone="warning">Overtime</Badge>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="font-medium">
                          {o.username} · {centsToUsd(o.amount_cent)} overtime pay
                        </div>
                        <div className="text-xs text-muted">
                          {o.date} · over by {formatMinutes(o.overtimeMin)} · {centsToUsd(o.amount_cent)} paid
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          Already paid. Accept to leave it as is, or revoke it to deduct the pay.
                        </div>
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === `ot-ok:${key}`}
                            onClick={() =>
                              act(`ot-ok:${key}`, '/api/admin/overtime/decision', {
                                body: { ...body, decision: 'ACCEPTED' },
                                success: `Overtime stands — ${centsToUsd(o.amount_cent)} stays in ${o.username}'s pay.`,
                              })
                            }
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant={confirming === `ot-no:${key}` ? 'danger' : 'ghost'}
                            loading={busy === `ot-no:${key}`}
                            onClick={() => {
                              if (confirming !== `ot-no:${key}`) {
                                setConfirming(`ot-no:${key}`);
                                return;
                              }
                              void act(`ot-no:${key}`, '/api/admin/overtime/decision', {
                                body: { ...body, decision: 'REVOKED' },
                                success: `Overtime revoked — ${centsToUsd(o.amount_cent)} removed from ${o.username}'s pay.`,
                              });
                            }}
                          >
                            {confirming === `ot-no:${key}` ? 'Tap again to confirm' : 'Revoke'}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
                {att.pendingAdvances.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="primary">Advance</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{a.username} requested {centsToUsd(a.amount_cent)}</div>
                      {a.reason && <div className="text-xs text-muted">{a.reason}</div>}
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="success"
                          loading={busy === `adv-ok:${a.id}`}
                          onClick={() =>
                            act(`adv-ok:${a.id}`, `/api/admin/advances/${a.id}/decision`, {
                              body: { decision: 'APPROVED' },
                              success: `Advance approved — ${centsToUsd(a.amount_cent)} will be deducted from ${a.username}'s pay this month.`,
                            })
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant={confirming === `adv-no:${a.id}` ? 'danger' : 'secondary'}
                          loading={busy === `adv-no:${a.id}`}
                          onClick={() => reject(`adv-no:${a.id}`, `/api/admin/advances/${a.id}/decision`, 'Advance')}
                        >
                          {confirming === `adv-no:${a.id}` ? 'Tap again to confirm' : 'Reject'}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
                {att.pendingLeaves.map((l) => (
                  <li key={l.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Badge tone="primary">Leave</Badge>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">
                        {l.username} · {l.kind === 'DAY_OFF' ? 'day off' : 'hours change'}
                        {l.kind === 'HOURS_CHANGE' && l.off_min != null ? ` → ${l.off_min / 60}h off` : ''}
                      </div>
                      <div className="text-xs text-muted">
                        {l.start_date}{l.end_date !== l.start_date ? ` → ${l.end_date}` : ''}{l.note ? ` · ${l.note}` : ''}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {l.kind === 'DAY_OFF'
                          ? 'Approving marks those days off on their schedule.'
                          : 'Approving rewrites their hours for those days automatically.'}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="success"
                          loading={busy === `lv-ok:${l.id}`}
                          onClick={() =>
                            act(`lv-ok:${l.id}`, `/api/admin/leave/${l.id}/decision`, {
                              body: { decision: 'APPROVED' },
                              success: (d) => {
                                const n = (d as { overrides_created?: number })?.overrides_created ?? 0;
                                const days = `${n} day${n === 1 ? '' : 's'}`;
                                return l.kind === 'HOURS_CHANGE' && l.off_min != null
                                  ? `Time off approved — ${l.username} owes ${l.off_min / 60}h less (${days} updated on their schedule).`
                                  : `Day off approved — ${days} marked off on ${l.username}'s schedule.`;
                              },
                            })
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant={confirming === `lv-no:${l.id}` ? 'danger' : 'secondary'}
                          loading={busy === `lv-no:${l.id}`}
                          onClick={() => reject(`lv-no:${l.id}`, `/api/admin/leave/${l.id}/decision`, 'Leave')}
                        >
                          {confirming === `lv-no:${l.id}` ? 'Tap again to confirm' : 'Reject'}
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

          <TelegramAlertsCard />
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
