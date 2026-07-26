'use client';

import { useEffect, useState } from 'react';
import { apiGet, formatBeirutTime } from '@/lib/api';
import { Card, CardBody, CardHeader, Badge, StatTile, EmptyState, PageHeader } from '@/components/ui';

export interface InitialData {
  branches: Array<{
    id: string;
    name: string;
    present: Array<{ id: string; username: string; in_at: string; minutes_since_in: number }>;
    absent: Array<{ id: string; username: string; role: string }>;
    driversOut: Array<{
      trip_id: string;
      driver_id: string;
      driver_username: string;
      branch_id: string;
      out_at: string;
      since_min: number;
      threshold_min: number;
    }>;
  }>;
  flags: Array<{
    id: string;
    kind: string;
    user_id: string | null;
    username: string | null;
    branch_id: string | null;
    branch_name: string | null;
    created_at: string;
    context_json: unknown;
  }>;
}

export interface AdminDashboardProps {
  initialData: InitialData;
}

const POLL_MS = 10_000;

const FLAG_LABEL: Record<string, string> = {
  WATCHED: 'No-show watch',
  MISSED_CHECKOUT: 'Missed checkout',
  TRIP_OVER_THRESHOLD: 'Trip over threshold',
};
const FLAG_TONE: Record<string, 'warning' | 'danger' | 'primary'> = {
  WATCHED: 'warning',
  MISSED_CHECKOUT: 'danger',
  TRIP_OVER_THRESHOLD: 'primary',
};

export default function AdminDashboard({ initialData }: AdminDashboardProps) {
  const [data, setData] = useState<InitialData>(initialData);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const r = await apiGet<InitialData>('/api/admin/now');
      if (alive && r.ok) {
        setData(r.data);
        setLastUpdated(new Date());
      }
    }
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const totalPresent = data.branches.reduce((s, b) => s + b.present.length, 0);
  const totalAbsent = data.branches.reduce((s, b) => s + b.absent.length, 0);
  const totalDriversOut = data.branches.reduce((s, b) => s + b.driversOut.length, 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live attendance across all branches"
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Live'}
          </span>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Present" value={totalPresent} tone="success" />
        <StatTile label="Absent" value={totalAbsent} tone={totalAbsent > 0 ? 'danger' : 'neutral'} />
        <StatTile label="Drivers out" value={totalDriversOut} tone={totalDriversOut > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Flags today" value={data.flags.length} tone={data.flags.length > 0 ? 'warning' : 'neutral'} />
      </div>

      {totalDriversOut > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-content">Drivers out</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.branches.flatMap((b) =>
              b.driversOut.map((d) => {
                const over = d.since_min > d.threshold_min;
                return (
                  <Card key={d.trip_id} className={over ? 'border-warning/40' : ''}>
                    <CardBody className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium">{d.driver_username}</div>
                        <div className="mt-0.5 text-xs text-muted">
                          {b.name} · out <span className="tabular">{d.since_min}</span> min (threshold {d.threshold_min})
                        </div>
                      </div>
                      {over && <Badge tone="warning">Over</Badge>}
                    </CardBody>
                  </Card>
                );
              }),
            )}
          </div>
        </section>
      )}

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Branches</h2>
          <span className="text-xs text-muted">
            {totalPresent} present · {totalAbsent} absent
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.branches.map((b) => (
            <Card key={b.id}>
              <CardBody>
                <div className="mb-3 font-semibold">{b.name}</div>
                <div className="grid grid-cols-3 gap-2">
                  <StatTile label="Present" value={b.present.length} tone="success" />
                  <StatTile label="Absent" value={b.absent.length} tone={b.absent.length > 0 ? 'danger' : 'neutral'} />
                  <StatTile label="Out" value={b.driversOut.length} tone={b.driversOut.length > 0 ? 'warning' : 'neutral'} />
                </div>
                {b.present.length > 0 && (
                  <div className="mt-3 text-xs text-muted">
                    <span className="font-medium text-content">In:</span>{' '}
                    {b.present.map((p) => p.username).join(', ')}
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-content">Today&apos;s flags</h2>
        {data.flags.length === 0 ? (
          <EmptyState title="No flags today" hint="Attendance issues raised by the system will appear here." />
        ) : (
          <Card>
            <CardHeader title="Flags" subtitle={`${data.flags.length} today`} />
            <ul className="divide-y divide-border">
              {data.flags.slice(0, 10).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-2">
                    <Badge tone={FLAG_TONE[f.kind] ?? 'neutral'}>{FLAG_LABEL[f.kind] ?? f.kind}</Badge>
                    <span className="text-sm">
                      {f.username ?? '—'}
                      {f.branch_name && <span className="text-muted"> · {f.branch_name}</span>}
                    </span>
                  </div>
                  <span className="tabular text-xs text-muted">{formatBeirutTime(f.created_at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </>
  );
}
