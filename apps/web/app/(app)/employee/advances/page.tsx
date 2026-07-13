'use client';

import { useEffect, useState } from 'react';

interface AdvancesSummary {
  pending: number;
  approved_balance_cent: number;
}

interface Advance {
  id: string;
  amount_cent: number;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  created_at: string;
  decided_at: string | null;
}

function getCookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1]! : '';
}

function readCsrf(): string {
  const raw = getCookie('csrf');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function EmployeeAdvancesPage() {
  const [summary, setSummary] = useState<AdvancesSummary | null>(null);
  const [list, setList] = useState<Advance[]>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [s, l] = await Promise.all([
      fetch('/api/me/advances', { credentials: 'include' }).then((r) => r.json()),
      fetch('/api/me/advances?view=list', { credentials: 'include' }).then((r) => (r.ok ? r.json() : { data: { advances: [] } })).catch(() => ({ data: { advances: [] } })),
    ]);
    if (s.ok) setSummary(s.data);
    if (l.ok) setList(l.data.advances);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cents = Math.round(Number(amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        setError('Enter a positive amount');
        return;
      }
      const res = await fetch('/api/me/advances', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `adv-${Date.now()}-${Math.random()}`,
          'X-CSRF-Token': readCsrf(),
        },
        body: JSON.stringify({ amountCent: cents, reason: reason || undefined }),
      });
      const body = await res.json();
      if (!body.ok) {
        setError(body.error?.code ?? 'ERROR');
        return;
      }
      setAmount('');
      setReason('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-semibold">Advances</h1>
      {summary && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded border p-3">
            <div className="text-sm text-gray-600">Pending</div>
            <div className="text-2xl font-bold">{summary.pending}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-sm text-gray-600">Approved balance</div>
            <div className="text-2xl font-bold">${(summary.approved_balance_cent / 100).toFixed(2)}</div>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-6 space-y-3">
        <label className="block">
          <span className="text-sm">Amount (USD)</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2 text-lg"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm">Reason (optional)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        {error && <div className="text-red-600 text-sm">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 text-white py-3 text-lg disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Request advance'}
        </button>
      </form>

      {list.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Your advances</h2>
          <ul className="mt-2 divide-y">
            {list.map((a) => (
              <li key={a.id} className="py-2 flex justify-between">
                <span>${(a.amount_cent / 100).toFixed(2)}</span>
                <span className="text-sm text-gray-600">{a.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}