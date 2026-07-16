'use client';

import { useState } from 'react';

export interface EditUser {
  id: string;
  username: string;
  role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
  branch_id: string | null;
  hourly_rate_cent: number;
}

export interface BranchOption {
  id: string;
  name: string;
}

export interface UserEditModalProps {
  user: EditUser;
  branches: BranchOption[];
  onClose: () => void;
  onSaved: () => void;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function UserEditModal({ user, branches, onClose, onSaved }: UserEditModalProps) {
  const [role, setRole] = useState(user.role);
  const [branchId, setBranchId] = useState(user.branch_id ?? branches[0]?.id ?? '');
  const [rate, setRate] = useState((user.hourly_rate_cent / 100).toFixed(2));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey(),
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({
          role,
          branchId: role === 'ADMIN' ? null : branchId,
          hourlyRateCent: Math.round(Number(rate) * 100),
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error?.code ?? 'ERROR');
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-20 flex items-start sm:items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-lg p-4 w-full max-w-md space-y-3">
        <h2 className="text-lg font-semibold">Edit {user.username}</h2>
        <label className="block">
          <span className="text-sm">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'EMPLOYEE' | 'DRIVER' | 'ADMIN')} className="mt-1 w-full rounded border px-3 py-2">
            <option value="EMPLOYEE">Employee</option>
            <option value="DRIVER">Driver</option>
            <option value="ADMIN">Admin</option>
          </select>
        </label>
        {role !== 'ADMIN' && (
          <label className="block">
            <span className="text-sm">Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="mt-1 w-full rounded border px-3 py-2">
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-sm">Hourly rate (USD)</span>
          <input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" />
          <span className="text-xs text-gray-500">A new RateChange row is inserted on save. Past punches use the old rate.</span>
        </label>
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="min-h-[44px] rounded bg-gray-200 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="min-h-[44px] rounded bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}