'use client';

import { useEffect, useState } from 'react';

export interface NewUser {
  id: string;
  username: string;
  role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
  branch_id: string | null;
  hourly_rate_cent: number;
  is_active: boolean;
}

export interface BranchOption {
  id: string;
  name: string;
}

export interface UserCreateModalProps {
  branches: BranchOption[];
  onClose: () => void;
  onSuccess: (user: NewUser, tempPassword: string) => void;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validate(username: string, password: string, role: string, branchId: string, rate: string): string | null {
  if (!username.trim()) return 'Username required';
  if (!password) return 'Password required';
  if (password.length < 4) return 'Password too short';
  if (!['EMPLOYEE', 'DRIVER', 'ADMIN'].includes(role)) return 'Invalid role';
  if ((role === 'EMPLOYEE' || role === 'DRIVER') && !branchId) return 'Branch required for non-admin';
  if (!rate || isNaN(Number(rate)) || Number(rate) < 0) return 'Rate must be positive (USD/hour)';
  return null;
}

export default function UserCreateModal({ branches, onClose, onSuccess }: UserCreateModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'EMPLOYEE' | 'DRIVER' | 'ADMIN'>('EMPLOYEE');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [rate, setRate] = useState('2.00');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (role === 'ADMIN') setBranchId('');
  }, [role]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate(username, password, role, branchId, rate);
    if (v) {
      setErr(v);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/admin/users', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey(),
          'X-CSRF-Token': csrfFromCookie() ?? '',
        },
        body: JSON.stringify({
          username,
          password,
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
      onSuccess(j.data.user, j.data.temp_password);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-20 flex items-start sm:items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-lg p-4 w-full max-w-md space-y-3">
        <h2 className="text-lg font-semibold">New user</h2>
        <label className="block">
          <span className="text-sm">Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" required />
        </label>
        <label className="block">
          <span className="text-sm">Password</span>
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded border px-3 py-2" required />
          <span className="text-xs text-gray-500">Share this with the employee verbally. No email.</span>
        </label>
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
        </label>
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="min-h-[44px] rounded bg-gray-200 px-4 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="min-h-[44px] rounded bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}