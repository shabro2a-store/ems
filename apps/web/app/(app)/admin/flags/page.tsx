'use client';

import { useEffect, useState } from 'react';
import AdminNav from '@/components/admin/AdminNav';

interface Flag {
  id: string;
  kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD';
  user_id: string | null;
  branch_id: string | null;
  context_json: unknown;
  created_at: string;
  notified_at: string | null;
  user: { username: string } | null;
  branch: { name: string } | null;
}

function kindColor(kind: Flag['kind']): string {
  switch (kind) {
    case 'WATCHED': return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'MISSED_CHECKOUT': return 'bg-red-100 text-red-800 border-red-300';
    case 'TRIP_OVER_THRESHOLD': return 'bg-orange-100 text-orange-800 border-orange-300';
  }
}

function kindLabel(kind: Flag['kind']): string {
  switch (kind) {
    case 'WATCHED': return 'Watched';
    case 'MISSED_CHECKOUT': return 'Missed checkout';
    case 'TRIP_OVER_THRESHOLD': return 'Trip over threshold';
  }
}

export default function AdminFlagsPage() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [username, setUsername] = useState<string>('');
  const [filterKind, setFilterKind] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load() {
    const res = await fetch('/api/admin/now', { credentials: 'include' });
    const body = await res.json();
    if (body.ok) {
      setFlags(body.data.flags ?? []);
    }
  }

  useEffect(() => {
    fetch('/api/me/ping', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) setUsername(j.data.userId ?? '');
    }).catch(() => {});
    load();
  }, []);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = filterKind ? flags.filter((f) => f.kind === filterKind) : flags;

  return (
    <>
      <AdminNav username={username || 'admin'} flagCount={flags.length} />
      <main className="p-4 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-semibold">Flags</h1>
          <button
            onClick={load}
            className="min-h-[44px] rounded bg-gray-200 px-3 py-2 text-sm"
          >
            Refresh
          </button>
        </div>

        <label className="block mb-3">
          <span className="text-sm">Filter by kind</span>
          <select
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value)}
            className="mt-1 rounded border px-3 py-2"
          >
            <option value="">All</option>
            <option value="WATCHED">Watched</option>
            <option value="MISSED_CHECKOUT">Missed checkout</option>
            <option value="TRIP_OVER_THRESHOLD">Trip over threshold</option>
          </select>
        </label>

        {filtered.length === 0 ? (
          <p className="text-gray-600">No flags.</p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((f) => (
              <li key={f.id}>
                <div
                  className={`rounded border p-3 ${kindColor(f.kind)}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{kindLabel(f.kind)}</span>
                      {f.user && (
                        <span className="text-sm">· {f.user.username}</span>
                      )}
                      {f.branch && (
                        <span className="text-sm">· {f.branch.name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs">
                        {new Date(f.created_at).toLocaleString('en-LB', { timeZone: 'Asia/Beirut' })}
                      </span>
                      <button
                        onClick={() => toggleExpand(f.id)}
                        className="text-xs underline"
                      >
                        {expanded.has(f.id) ? 'Hide' : 'Details'}
                      </button>
                    </div>
                  </div>
                  {expanded.has(f.id) && (
                    <div className="mt-2 text-xs font-mono bg-white/50 rounded p-2">
                      <pre className="whitespace-pre-wrap break-all">
                        {JSON.stringify(f.context_json, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}