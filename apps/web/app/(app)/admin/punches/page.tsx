'use client';

import { useEffect, useState } from 'react';

interface Punch {
  id: string;
  user_id: string;
  branch_id: string;
  kind: 'IN' | 'OUT';
  at: string;
  lat: number;
  lng: number;
  accuracy_m: number;
  user: { username: string };
  branch: { name: string };
}

interface Branch {
  id: string;
  name: string;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AdminPunchesPage() {
  const [punches, setPunches] = useState<Punch[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [username, setUsername] = useState<string>('');
  const [correctTarget, setCorrectTarget] = useState<Punch | null>(null);
  const [corrAt, setCorrAt] = useState<string>('');
  const [corrBranch, setCorrBranch] = useState<string>('');
  const [corrReason, setCorrReason] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  async function load() {
    const [pRes, bRes] = await Promise.all([
      fetch('/api/admin/punches', { credentials: 'include' }),
      fetch('/api/admin/branches', { credentials: 'include' }),
    ]);
    if (pRes.ok) {
      const body = await pRes.json();
      if (body.ok) {
        setPunches(body.data?.punches ?? []);
      }
    }
    if (bRes.ok) {
      const body = await bRes.json();
      if (body.ok) setBranches(body.data.branches ?? []);
    }
  }

  useEffect(() => {
    fetch('/api/me/ping', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) setUsername(j.data.userId ?? '');
    }).catch(() => {});
    load();
  }, []);

  async function correct(p: Punch) {
    setCorrectTarget(p);
    setCorrAt(p.at.slice(0, 16));
    setCorrBranch(p.branch_id);
    setCorrReason('');
    setErr(null);
    setSuccess(false);
  }

  async function submitCorrect(e: React.FormEvent) {
    e.preventDefault();
    if (!correctTarget) return;
    setBusy(true);
    setErr(null);
    setSuccess(false);
    try {
      const r = await fetch('/api/admin/punches/correct', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey(),
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({
          punchId: correctTarget.id,
          newAt: new Date(corrAt).toISOString(),
          newBranchId: corrBranch || undefined,
          reason: corrReason,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      setCorrectTarget(null);
      setSuccess(true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  function formatTs(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('en-LB', { timeZone: 'Asia/Beirut' });
  }

  return (
    <>
      <main className="p-4 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-semibold">Punches</h1>
          <button
            onClick={load}
            className="min-h-[44px] rounded bg-gray-200 px-3 py-2 text-sm"
          >
            Refresh
          </button>
        </div>

        {success && <div className="mb-3 text-green-600 text-sm">Correction saved.</div>}
        {err && <div className="mb-3 text-red-600 text-sm">{err}</div>}

        {punches.length === 0 ? (
          <p className="text-gray-600">No punches found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-gray-100">
                <tr>
                  <th className="text-left p-2">User</th>
                  <th className="text-left p-2">Branch</th>
                  <th className="text-left p-2">Kind</th>
                  <th className="text-left p-2">Time (Beirut)</th>
                  <th className="text-left p-2">Location</th>
                  <th className="text-left p-2">Accuracy</th>
                  <th className="text-left p-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {punches.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-2">{p.user.username}</td>
                    <td className="p-2">{p.branch.name}</td>
                    <td className="p-2">
                      <span className={`rounded px-2 py-1 text-xs ${p.kind === 'IN' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                        {p.kind}
                      </span>
                    </td>
                    <td className="p-2 font-mono text-xs">{formatTs(p.at)}</td>
                    <td className="p-2 font-mono text-xs">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</td>
                    <td className="p-2 text-xs">{p.accuracy_m}m</td>
                    <td className="p-2">
                      <button
                        onClick={() => correct(p)}
                        className="rounded bg-blue-500 text-white px-2 py-1 text-xs"
                      >
                        Correct
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {correctTarget && (
          <div className="fixed inset-0 bg-black/50 z-20 flex items-start sm:items-center justify-center p-4">
            <form onSubmit={submitCorrect} className="bg-white rounded-lg p-4 w-full max-w-md space-y-3">
              <h2 className="text-lg font-semibold">Correct punch</h2>
              <p className="text-xs text-gray-500">
                User: {correctTarget.user.username} · Original: {formatTs(correctTarget.at)}
              </p>
              <label className="block">
                <span className="text-sm">New time (Beirut)</span>
                <input
                  type="datetime-local"
                  value={corrAt}
                  onChange={(e) => setCorrAt(e.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2"
                  required
                />
              </label>
              <label className="block">
                <span className="text-sm">New branch (optional)</span>
                <select
                  value={corrBranch}
                  onChange={(e) => setCorrBranch(e.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2"
                >
                  <option value="">Keep original</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm">Reason</span>
                <input
                  type="text"
                  value={corrReason}
                  onChange={(e) => setCorrReason(e.target.value)}
                  className="mt-1 w-full rounded border px-3 py-2"
                  placeholder="e.g. employee arrived late"
                  required
                  maxLength={500}
                />
              </label>
              {err && <div className="text-red-600 text-sm">{err}</div>}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setCorrectTarget(null)}
                  className="min-h-[44px] rounded bg-gray-200 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="min-h-[44px] rounded bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
    </>
  );
}