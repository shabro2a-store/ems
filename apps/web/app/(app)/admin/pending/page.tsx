'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface PendingAdvance {
  id: string;
  amount_cent: number;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  created_at: string;
  user: { id: string; username: string };
}

function getCookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]!) : '';
}

function PendingInner() {
  const sp = useSearchParams();
  const focus = sp.get('focus');
  const [list, setList] = useState<PendingAdvance[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/admin/advances', { credentials: 'include' });
    const body = await res.json();
    if (body.ok) setList(body.data.advances);
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (focus) {
      const el = document.getElementById(`row-${focus}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focus, list]);

  async function decide(id: string, decision: 'APPROVED' | 'REJECTED') {
    setBusy(id);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/advances/${id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `dec-${id}-${Date.now()}`,
          'X-CSRF-Token': getCookie('csrf'),
        },
        body: JSON.stringify({ decision }),
      });
      const body = await res.json();
      if (!body.ok) {
        setErr(body.error?.code ?? 'ERROR');
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold">Pending advances</h1>
      {err && <div className="mt-2 text-red-600">{err}</div>}
      {list.length === 0 ? (
        <p className="mt-4 text-gray-600">No pending advances.</p>
      ) : (
        <ul className="mt-4 divide-y">
          {list.map((a) => (
            <li
              id={`row-${a.id}`}
              key={a.id}
              className={`py-3 flex items-center justify-between ${focus === a.id ? 'bg-yellow-50' : ''}`}
            >
              <div>
                <div className="font-medium">${(a.amount_cent / 100).toFixed(2)} — {a.user.username}</div>
                {a.reason && <div className="text-sm text-gray-600">{a.reason}</div>}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => decide(a.id, 'APPROVED')}
                  disabled={busy === a.id}
                  className="rounded bg-green-600 text-white px-3 py-2 text-sm disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  onClick={() => decide(a.id, 'REJECTED')}
                  disabled={busy === a.id}
                  className="rounded bg-red-600 text-white px-3 py-2 text-sm disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default function AdminPendingPage() {
  return (
    <Suspense fallback={<main className="p-6">Loading…</main>}>
      <PendingInner />
    </Suspense>
  );
}