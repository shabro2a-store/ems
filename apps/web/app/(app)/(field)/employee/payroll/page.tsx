'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, centsToUsd } from '@/lib/api';
import { Card, CardBody, CardHeader, Field, Input, Spinner, StatTile } from '@/components/ui';

// The owner's ruling: staff track their hours, advances, penalties and bonuses
// here - not what they earned. The server does not send gross, trip pay or
// take-home, so there is nothing of it to show.
interface MonthData {
  month: string;
  hours: number;
  blocked_credit_min: number;
  trips_count: number;
  trips_denied: number;
  adjustments: Array<{ id: string; kind: 'BONUS' | 'DEDUCTION'; amount_cent: number; reason: string; created_at: string }>;
  adjustments_cent: number;
  penalties: Array<{ date: string; shortfall_min: number; amount_cent: number }>;
  penalties_cent: number;
  overtime_deduction_cent: number;
  advances_cent: number;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Beirut' });
}

function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function EmployeeMonthPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<MonthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const r = await apiGet<MonthData>(`/api/me/payroll?month=${month}`);
      setData(r.ok ? r.data : null);
      setLoading(false);
    })();
  }, [month]);

  const drives = data !== null && (data.trips_count > 0 || data.trips_denied > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">My month</h1>
        <Field htmlFor="m"><Input id="m" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-auto" /></Field>
      </div>

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : !data ? (
        <p className="text-sm text-muted">This month could not be loaded. Open it again in a moment.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Hours" value={data.hours.toFixed(1)} />
            {drives ? (
              <StatTile label="Deliveries" value={data.trips_count} />
            ) : (
              <StatTile label="Advances" value={data.advances_cent ? centsToUsd(data.advances_cent) : '—'} />
            )}
          </div>

          <Card>
            <CardHeader title="Hours" subtitle={month} />
            <CardBody>
              <dl className="divide-y divide-border text-sm">
                <Line k="Hours worked" v={`${data.hours.toFixed(1)}h`} />
                {/* Inside the hours above, never added to them. Without the line
                    the month shows hours they know they did not clock. */}
                {data.blocked_credit_min > 0 && (
                  <Line k="of which time you could not clock in" v={duration(data.blocked_credit_min)} />
                )}
                {drives && (
                  <Line
                    k="Deliveries"
                    v={`${data.trips_count}${data.trips_denied > 0 ? ` (${data.trips_denied} denied)` : ''}`}
                  />
                )}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Bonuses and deductions" />
            <CardBody>
              {data.adjustments.length === 0 ? (
                <p className="text-sm text-muted">None this month.</p>
              ) : (
                // Each one with the reason it was given: the reason is what
                // makes it a decision rather than a number that appeared.
                <ul className="divide-y divide-border text-sm">
                  {data.adjustments.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 py-2.5">
                      <span className="min-w-0 text-muted">{a.reason}</span>
                      <span className={`tabular shrink-0 font-medium ${a.kind === 'BONUS' ? 'text-success' : 'text-danger'}`}>
                        {a.kind === 'BONUS' ? '+' : '−'}{centsToUsd(a.amount_cent, false)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Penalties" subtitle="Days you were short of your hours" />
            <CardBody>
              {data.penalties.length === 0 && !data.overtime_deduction_cent ? (
                <p className="text-sm text-muted">None this month.</p>
              ) : (
                <dl className="divide-y divide-border text-sm">
                  {data.penalties.map((p) => (
                    <Line key={p.date} k={`${dayLabel(p.date)} · ${duration(p.shortfall_min)} short`} v={`−${centsToUsd(p.amount_cent, false)}`} tone="danger" />
                  ))}
                  {data.overtime_deduction_cent > 0 && (
                    <Line k="Overtime not approved" v={`−${centsToUsd(data.overtime_deduction_cent, false)}`} tone="danger" />
                  )}
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Advances" />
            <CardBody>
              <dl className="divide-y divide-border text-sm">
                <Line k="Taken out of this month" v={data.advances_cent ? `−${centsToUsd(data.advances_cent, false)}` : '—'} tone={data.advances_cent ? 'danger' : undefined} />
              </dl>
              <Link href="/employee/advances" className="mt-2 inline-block text-sm font-medium text-primary">
                See or request advances
              </Link>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function Line({ k, v, tone }: { k: string; v: string; tone?: 'success' | 'danger' }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <dt className="min-w-0 text-muted">{k}</dt>
      <dd className={`tabular shrink-0 font-medium ${tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : ''}`}>{v}</dd>
    </div>
  );
}
