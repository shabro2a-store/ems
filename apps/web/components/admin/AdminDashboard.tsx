'use client';

import { useEffect, useState } from 'react';

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

export default function AdminDashboard({ initialData }: AdminDashboardProps) {
  const [data, setData] = useState<InitialData>(initialData);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await fetch('/api/admin/now', { credentials: 'include' });
        const j = await r.json();
        if (alive && j.ok) {
          setData(j.data);
          setLastUpdated(new Date());
        }
      } catch {
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
    <main className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="text-xs text-gray-500">
          {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Loading…'}
        </div>
      </div>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase mb-2">Drivers out</h2>
        {totalDriversOut === 0 ? (
          <p className="text-sm text-gray-500">No drivers currently out.</p>
        ) : (
          <ul className="space-y-2">
            {data.branches.flatMap((b) =>
              b.driversOut.map((d) => {
                const over = d.since_min > d.threshold_min;
                return (
                  <li
                    key={d.trip_id}
                    className={`rounded border p-3 ${over ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-200'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{d.driver_username}</div>
                        <div className="text-xs text-gray-600">
                          {b.name} · out {d.since_min} min (threshold {d.threshold_min} min)
                        </div>
                      </div>
                      {over && (
                        <span className="text-xs rounded bg-amber-500 text-white px-2 py-1">
                          OVER
                        </span>
                      )}
                    </div>
                  </li>
                );
              }),
            )}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-700 uppercase mb-2">Branches</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.branches.map((b) => (
            <div key={b.id} className="rounded border border-gray-200 bg-white p-3">
              <div className="font-semibold mb-2">{b.name}</div>
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded bg-green-50 p-2">
                  <div className="text-xs text-green-700">Present</div>
                  <div className="text-xl font-bold text-green-900">{b.present.length}</div>
                </div>
                <div className="rounded bg-red-50 p-2">
                  <div className="text-xs text-red-700">Absent</div>
                  <div className="text-xl font-bold text-red-900">{b.absent.length}</div>
                </div>
                <div className="rounded bg-orange-50 p-2">
                  <div className="text-xs text-orange-700">Driver out</div>
                  <div className="text-xl font-bold text-orange-900">{b.driversOut.length}</div>
                </div>
              </div>
              {b.present.length > 0 && (
                <div className="mt-2 text-xs text-gray-600">
                  In: {b.present.map((p) => p.username).join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="text-xs text-gray-500 mt-2 text-right">
          Total: {totalPresent} present · {totalAbsent} absent
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 uppercase mb-2">Today's flags</h2>
        {data.flags.length === 0 ? (
          <p className="text-sm text-gray-500">No flags today.</p>
        ) : (
          <ul className="divide-y rounded border border-gray-200 bg-white">
            {data.flags.slice(0, 10).map((f) => (
              <li key={f.id} className="p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {f.kind} {f.username ? `· ${f.username}` : ''}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(f.created_at).toLocaleTimeString()}
                  </span>
                </div>
                {f.branch_name && (
                  <div className="text-xs text-gray-600">Branch: {f.branch_name}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}