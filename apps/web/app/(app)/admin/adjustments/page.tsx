'use client';

import { useEffect, useState } from 'react';

interface Adjustment {
  id: string;
  user_id: string;
  kind: 'BONUS' | 'DEDUCTION';
  amount_cent: number;
  reason: string;
  period: string;
  created_at: string;
  user: { id: string; username: string };
}

interface User {
  id: string;
  username: string;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentMonthPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}

function thisMonthLabel(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function AdminAdjustmentsPage() {
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState<string>('');
  const [filterUser, setFilterUser] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [formUser, setFormUser] = useState<string>('');
  const [formKind, setFormKind] = useState<'BONUS' | 'DEDUCTION'>('BONUS');
  const [formAmount, setFormAmount] = useState<string>('');
  const [formReason, setFormReason] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  async function loadAdjustments() {
    const res = await fetch('/api/admin/adjustments', { credentials: 'include' });
    const body = await res.json();
    if (body.ok) {
      setAdjustments(body.data.adjustments ?? []);
    }
  }

  async function loadUsers() {
    const res = await fetch('/api/admin/users', { credentials: 'include' });
    const body = await res.json();
    if (body.ok) setUsers(body.data.users ?? []);
  }

  useEffect(() => {
    fetch('/api/me/ping', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) setUsername(j.data.userId ?? '');
    }).catch(() => {});
    loadAdjustments();
    loadUsers();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSuccess(false);
    setBusy(true);
    try {
      const r = await fetch('/api/admin/adjustments', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey(),
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({
          userId: formUser,
          kind: formKind,
          amountCent: Math.round(parseFloat(formAmount) * 100),
          reason: formReason,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      setFormUser('');
      setFormAmount('');
      setFormReason('');
      setShowForm(false);
      setSuccess(true);
      await loadAdjustments();
    } finally {
      setBusy(false);
    }
  }

  const filtered = filterUser
    ? adjustments.filter((a) => a.user_id === filterUser)
    : adjustments;

  const monthLabel = thisMonthLabel();

  return (
    <>
      <main className="p-4 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-semibold">Adjustments</h1>
          <button
            onClick={() => { setShowForm(true); setSuccess(false); setErr(null); }}
            className="min-h-[56px] rounded bg-blue-600 text-white px-4 py-2 text-base"
          >
            Add adjustment
          </button>
        </div>

        <label className="block mb-3">
          <span className="text-sm">Filter by user</span>
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="mt-1 rounded border px-3 py-2 w-full sm:w-auto"
          >
            <option value="">All users</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
        </label>

        {success && <div className="mb-3 text-green-600 text-sm">Adjustment added.</div>}
        {err && <div className="mb-3 text-red-600 text-sm">{err}</div>}

        {filtered.length === 0 ? (
          <p className="text-gray-600">No adjustments this month.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-gray-100">
                <tr>
                  <th className="text-left p-2">User</th>
                  <th className="text-left p-2">Kind</th>
                  <th className="text-left p-2">Amount</th>
                  <th className="text-left p-2">Reason</th>
                  <th className="text-left p-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="p-2">{a.user.username}</td>
                    <td className="p-2">
                      <span className={`rounded px-2 py-1 text-xs ${a.kind === 'BONUS' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                        {a.kind}
                      </span>
                    </td>
                    <td className="p-2 font-mono">{usd(a.amount_cent)}</td>
                    <td className="p-2">{a.reason}</td>
                    <td className="p-2 text-gray-600">{new Date(a.created_at).toLocaleDateString('en-LB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {showForm && (
          <div className="fixed inset-0 bg-black/50 z-20 flex items-start sm:items-center justify-center p-4">
            <form onSubmit={submit} className="bg-white rounded-lg p-4 w-full max-w-md space-y-3">
              <h2 className="text-lg font-semibold">Add adjustment</h2>
              <p className="text-xs text-gray-500">Month: {monthLabel}</p>
              <label className="block">
                <span className="text-sm">User</span>
                <select
                  value={formUser}
                  onChange={(e) => setFormUser(e.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2"
                  required
                >
                  <option value="">Select user</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm">Kind</span>
                <select
                  value={formKind}
                  onChange={(e) => setFormKind(e.target.value as 'BONUS' | 'DEDUCTION')}
                  className="mt-1 w-full rounded border px-3 py-2"
                >
                  <option value="BONUS">Bonus (+)</option>
                  <option value="DEDUCTION">Deduction (-)</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm">Amount (USD)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2"
                  placeholder="0.00"
                  required
                />
              </label>
              <label className="block">
                <span className="text-sm">Reason</span>
                <input
                  type="text"
                  value={formReason}
                  onChange={(e) => setFormReason(e.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2"
                  placeholder="e.g. performance bonus"
                  required
                  maxLength={500}
                />
              </label>
              {err && <div className="text-red-600 text-sm">{err}</div>}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="min-h-[44px] rounded bg-gray-200 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[44px] rounded bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
    </>
  );
}