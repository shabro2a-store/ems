'use client';

import { useEffect, useState } from 'react';

interface LeaveSummary {
  pending: number;
  upcoming: Array<{ date: string; kind: string; note: string | null }>;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function EmployeeLeavePage() {
  const [summary, setSummary] = useState<LeaveSummary | null>(null);
  const [kind, setKind] = useState<'DAY_OFF' | 'TIME_CHANGE'>('DAY_OFF');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await fetch('/api/me/leave', { credentials: 'include' });
    const j = await r.json();
    if (j.ok) setSummary(j.data);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch('/api/me/leave', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey(),
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({
          kind,
          start_date: start,
          end_date: end,
          note: note || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      setStart('');
      setEnd('');
      setNote('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-semibold">Leave requests</h1>

      {summary && (
        <p className="mt-2 text-sm text-gray-600">
          {summary.pending} pending
        </p>
      )}

      <form onSubmit={submit} className="mt-6 space-y-3">
        <label className="block">
          <span className="text-sm">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'DAY_OFF' | 'TIME_CHANGE')}
            className="mt-1 w-full rounded border px-3 py-2"
          >
            <option value="DAY_OFF">Day off</option>
            <option value="TIME_CHANGE">Time change</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm">Start date</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">End date</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">Note (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 text-white py-3 text-lg disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Request leave'}
        </button>
      </form>

      {summary && summary.upcoming.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Upcoming overrides</h2>
          <ul className="mt-2 divide-y">
            {summary.upcoming.map((u) => (
              <li key={u.date} className="py-2 flex justify-between">
                <span>{u.date}</span>
                <span className="text-sm text-gray-600">{u.kind}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}