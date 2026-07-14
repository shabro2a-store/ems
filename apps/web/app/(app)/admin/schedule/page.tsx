'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

interface ScheduleRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}
interface OverrideRow {
  id: string;
  date: string;
  kind: 'DAY_OFF' | 'TIME_CHANGE';
  source: string;
}
interface PendingLeave {
  id: string;
  kind: 'DAY_OFF' | 'TIME_CHANGE';
  start_date: string;
  end_date: string;
  note: string | null;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ScheduleInner() {
  const sp = useSearchParams();
  const userId = sp.get('userId') ?? '';
  const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [pendingLeaves, setPendingLeaves] = useState<PendingLeave[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    const r = await fetch('/api/admin/advances', { credentials: 'include' });
    const j = await r.json();
    if (j.ok) {
      const us = new Map<string, { id: string; username: string }>();
      for (const a of j.data.advances) us.set(a.user.id, a.user);
      setUsers(Array.from(us.values()));
    }
  }, []);

  const loadSchedule = useCallback(async (uid: string) => {
    if (!uid) return;
    const r = await fetch(`/api/admin/schedules/${uid}`, { credentials: 'include' });
    const j = await r.json();
    if (j.ok) {
      setSchedule(j.data.weeklySchedule);
      setOverrides(j.data.overrides.map((o: { id: string; date: string; kind: 'DAY_OFF' | 'TIME_CHANGE'; source: string }) => ({
        id: o.id,
        date: o.date.slice(0, 10),
        kind: o.kind,
        source: o.source,
      })));
      setPendingLeaves(
        j.data.pendingLeaves.map((l: { id: string; kind: 'DAY_OFF' | 'TIME_CHANGE'; start_date: string; end_date: string; note: string | null }) => ({
          id: l.id,
          kind: l.kind,
          start_date: l.start_date.slice(0, 10),
          end_date: l.end_date.slice(0, 10),
          note: l.note,
        })),
      );
    } else {
      setErr(j.error?.code ?? 'ERROR');
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    loadSchedule(userId);
  }, [userId, loadSchedule]);

  const setRow = (weekday: number, key: 'start_time' | 'end_time', val: string) => {
    setSchedule((prev) => {
      const existing = prev.find((p) => p.weekday === weekday);
      if (existing) {
        return prev.map((p) => (p.weekday === weekday ? { ...p, [key]: val } : p));
      }
      return [
        ...prev,
        {
          id: `tmp-${weekday}`,
          weekday,
          start_time: key === 'start_time' ? val : '09:00',
          end_time: key === 'end_time' ? val : '18:00',
        },
      ];
    });
  };

  const getRow = (weekday: number): ScheduleRow | undefined => schedule.find((p) => p.weekday === weekday);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/schedules/${userId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({ weeklySchedule: schedule.map((s) => ({ weekday: s.weekday, start_time: s.start_time, end_time: s.end_time })) }),
      });
      const j = await r.json();
      if (!j.ok) setErr(j.error?.code ?? 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const decideLeave = async (leaveId: string, decision: 'APPROVED' | 'REJECTED') => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/leave/${leaveId}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey(),
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({ decision }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      await loadSchedule(userId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold">Schedule editor</h1>

      <label className="mt-4 block">
        <span className="text-sm">User</span>
        <select
          value={userId}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set('userId', e.target.value);
            window.history.replaceState(null, '', url.toString());
            window.location.reload();
          }}
          className="mt-1 rounded border px-3 py-2"
        >
          <option value="">Select user</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.username}</option>
          ))}
        </select>
      </label>

      {err && <div className="mt-2 text-red-600 text-sm">{err}</div>}

      {userId && (
        <>
          <h2 className="mt-6 text-lg font-semibold">Weekly grid</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr>
                {WEEKDAY_LABELS.map((d) => <th key={d} className="text-left p-1">{d}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                {WEEKDAY_LABELS.map((_d, i) => {
                  const row = getRow(i);
                  return (
                    <td key={i} className="p-1">
                      <input
                        type="time"
                        value={row?.start_time ?? ''}
                        onChange={(e) => setRow(i, 'start_time', e.target.value)}
                        className="block w-full rounded border px-1 py-1"
                      />
                      <input
                        type="time"
                        value={row?.end_time ?? ''}
                        onChange={(e) => setRow(i, 'end_time', e.target.value)}
                        className="mt-1 block w-full rounded border px-1 py-1"
                      />
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
          <button
            onClick={save}
            disabled={busy}
            className="mt-3 rounded bg-blue-600 text-white px-4 py-2 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save schedule'}
          </button>

          {overrides.length > 0 && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold">Overrides</h2>
              <ul className="mt-2 divide-y text-sm">
                {overrides.map((o) => (
                  <li key={o.id} className="py-1 flex justify-between">
                    <span>{o.date}</span>
                    <span className="text-gray-600">{o.kind} ({o.source})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pendingLeaves.length > 0 && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold">Pending leave requests</h2>
              <ul className="mt-2 divide-y text-sm">
                {pendingLeaves.map((l) => (
                  <li key={l.id} className="py-2 flex items-center justify-between">
                    <div>
                      <div>{l.kind} — {l.start_date} → {l.end_date}</div>
                      {l.note && <div className="text-xs text-gray-600">{l.note}</div>}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => decideLeave(l.id, 'APPROVED')}
                        disabled={busy}
                        className="rounded bg-green-600 text-white px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => decideLeave(l.id, 'REJECTED')}
                        disabled={busy}
                        className="rounded bg-red-600 text-white px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default function AdminSchedulePage() {
  return (
    <Suspense fallback={<main className="p-6">Loading…</main>}>
      <ScheduleInner />
    </Suspense>
  );
}