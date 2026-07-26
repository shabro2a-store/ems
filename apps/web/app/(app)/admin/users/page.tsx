'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import UserCreateModal, { type BranchOption, type NewUser } from '@/components/admin/UserCreateModal';
import UserEditModal, { type EditUser } from '@/components/admin/UserEditModal';

interface UserRow {
  id: string;
  username: string;
  role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
  branch_id: string | null;
  hourly_rate_cent: number;
  is_active: boolean;
  notify_daily_summary: boolean;
  notify_routine_pings: boolean;
  branch: { id: string; name: string } | null;
}

function csrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? null;
}

function idemKey(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AdminUsersClient() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<EditUser | null>(null);
  const [tempPwdFor, setTempPwdFor] = useState<{ username: string; pwd: string } | null>(null);
  const [username, setUsername] = useState<string>('');

  async function load() {
    const [u, b] = await Promise.all([
      fetch('/api/admin/users', { credentials: 'include' }).then((r) => r.json()),
      fetch('/api/admin/branches', { credentials: 'include' }).then((r) => r.json()),
    ]);
    if (u.ok) setUsers(u.data.users);
    if (b.ok) setBranches(b.data.branches);
  }

  useEffect(() => {
    fetch('/api/me/ping', { credentials: 'include' }).then((r) => r.json()).then((j) => {
      if (j.ok) setUsername(j.data.userId ?? '');
    }).catch(() => {});
    load();
  }, []);

  async function toggleActive(u: UserRow) {
    const csrf = csrfFromCookie() ?? '';
    await fetch(`/api/admin/users/${u.id}/deactivate`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf },
    });
    await load();
  }

  async function resetPwd(u: UserRow) {
    const csrf = csrfFromCookie() ?? '';
    const r = await fetch(`/api/admin/users/${u.id}/reset-password`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf },
    });
    const j = await r.json();
    if (j.ok) {
      setTempPwdFor({ username: u.username, pwd: j.data.temp_password });
    } else {
      alert(j.error?.code ?? 'ERROR');
    }
  }

  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <>
      <main className="p-4 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-semibold">Users</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="min-h-[56px] rounded bg-blue-600 text-white px-4 py-2 text-base"
          >
            New user
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-gray-100">
              <tr>
                <th className="text-left p-2">Username</th>
                <th className="text-left p-2">Role</th>
                <th className="text-left p-2">Branch</th>
                <th className="text-left p-2">Rate</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Prefs</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="p-2">{u.username}</td>
                  <td className="p-2">{u.role}</td>
                  <td className="p-2">{u.branch?.name ?? '—'}</td>
                  <td className="p-2">{usd(u.hourly_rate_cent)}/h</td>
                  <td className="p-2">
                    <span className={`rounded px-2 py-1 text-xs ${u.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
                      {u.is_active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="p-2 text-xs text-gray-600">
                    {u.role === 'ADMIN' ? `daily:${u.notify_daily_summary ? 'on' : 'off'} · routine:${u.notify_routine_pings ? 'on' : 'off'}` : '—'}
                  </td>
                  <td className="p-2">
                    <div className="flex gap-1 flex-wrap">
                      <button
                        onClick={() => setEditTarget({
                          id: u.id, username: u.username, role: u.role,
                          branch_id: u.branch_id, hourly_rate_cent: u.hourly_rate_cent,
                        })}
                        className="rounded bg-blue-500 text-white px-2 py-1 text-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggleActive(u)}
                        className={`rounded ${u.is_active ? 'bg-red-500' : 'bg-green-600'} text-white px-2 py-1 text-xs`}
                      >
                        {u.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                      <button
                        onClick={() => resetPwd(u)}
                        className="rounded bg-gray-700 text-white px-2 py-1 text-xs"
                      >
                        Reset pw
                      </button>
                      {u.role === 'ADMIN' && (
                        <Link
                          href={`/admin/users/${u.id}/edit`}
                          className="rounded bg-purple-500 text-white px-2 py-1 text-xs"
                        >
                          Prefs
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {tempPwdFor && (
          <div className="fixed inset-0 bg-black/50 z-30 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg p-4 max-w-md w-full">
              <h3 className="text-lg font-semibold mb-2">Password reset for {tempPwdFor.username}</h3>
              <div className="bg-yellow-50 border border-yellow-300 rounded p-3 text-sm mb-3">
                Share this temporary password with {tempPwdFor.username} verbally. They must change it on first login.
              </div>
              <code className="block bg-gray-100 p-3 rounded text-lg">{tempPwdFor.pwd}</code>
              <button
                onClick={() => setTempPwdFor(null)}
                className="mt-3 min-h-[44px] w-full rounded bg-blue-600 text-white py-2"
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {showCreate && (
          <UserCreateModal
            branches={branches}
            onClose={() => setShowCreate(false)}
            onSuccess={(u, pwd) => {
              setTempPwdFor({ username: u.username, pwd });
              setShowCreate(false);
              load();
            }}
          />
        )}

        {editTarget && (
          <UserEditModal
            user={editTarget}
            branches={branches}
            onClose={() => setEditTarget(null)}
            onSaved={() => {
              setEditTarget(null);
              load();
            }}
          />
        )}
      </main>
    </>
  );
}