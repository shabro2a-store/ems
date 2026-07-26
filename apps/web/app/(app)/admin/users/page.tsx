'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiSend, centsToUsd, errorMessage } from '@/lib/api';
import {
  PageHeader, Card, CardHeader, Badge, Button, Modal, Field, Input, Select, EmptyState, Alert, Spinner, StatTile,
} from '@/components/ui';

type Role = 'EMPLOYEE' | 'DRIVER' | 'ADMIN';
interface User {
  id: string;
  username: string;
  role: Role;
  branch_id: string | null;
  branch: { id: string; name: string } | null;
  hourly_rate_cent: number;
  is_active: boolean;
}
interface Branch { id: string; name: string }
interface Status { status: 'IN' | 'ON_TRIP' | 'DAY_OFF' | 'ABSENT'; since_min: number; over: boolean }

const ROLE_TONE: Record<Role, 'primary' | 'warning' | 'neutral'> = { EMPLOYEE: 'primary', DRIVER: 'warning', ADMIN: 'neutral' };
const DAYS = [
  { wd: 0, name: 'Sunday' }, { wd: 1, name: 'Monday' }, { wd: 2, name: 'Tuesday' },
  { wd: 3, name: 'Wednesday' }, { wd: 4, name: 'Thursday' }, { wd: 5, name: 'Friday' }, { wd: 6, name: 'Saturday' },
];

export default function AdminEmployeesPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, Status>>({});
  const [branchId, setBranchId] = useState('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [schedUser, setSchedUser] = useState<User | null>(null);
  const [tempPw, setTempPw] = useState<{ username: string; pw: string } | null>(null);

  async function load() {
    setLoading(true);
    const [u, b, o] = await Promise.all([
      apiGet<{ users: User[] }>('/api/admin/users'),
      apiGet<{ branches: Branch[] }>('/api/admin/branches'),
      apiGet<{ people: { id: string; status: Status['status']; since_min: number; over: boolean }[] }>('/api/admin/overview'),
    ]);
    if (u.ok) setUsers(u.data.users);
    if (b.ok) setBranches(b.data.branches);
    if (o.ok) {
      const m: Record<string, Status> = {};
      for (const p of o.data.people) m[p.id] = { status: p.status, since_min: p.since_min, over: p.over };
      setStatusMap(m);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(
    () => (branchId === 'all' ? users : users.filter((u) => u.branch_id === branchId)),
    [users, branchId],
  );
  const grouped = useMemo(() => {
    const g = new Map<string, User[]>();
    for (const u of filtered) {
      const key = u.branch?.name ?? (u.role === 'ADMIN' ? 'Administrators' : 'Unassigned');
      (g.get(key) ?? g.set(key, []).get(key)!).push(u);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const stats = {
    total: filtered.length,
    active: filtered.filter((u) => u.is_active).length,
    employees: filtered.filter((u) => u.role === 'EMPLOYEE').length,
    drivers: filtered.filter((u) => u.role === 'DRIVER').length,
  };

  async function toggleActive(u: User) {
    setErr(null);
    const res = await apiSend(`/api/admin/users/${u.id}/deactivate`);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    await load();
  }
  async function resetPw(u: User) {
    setErr(null);
    const res = await apiSend<{ temp_password: string }>(`/api/admin/users/${u.id}/reset-password`);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    setTempPw({ username: u.username, pw: res.data.temp_password });
  }

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="Staff, roles, pay and weekly schedules"
        actions={
          <>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
              <option value="all">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Button onClick={() => { setErr(null); setCreateOpen(true); }}>＋ Add employee</Button>
          </>
        }
      />

      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}
      {notice && <div className="mb-3"><Alert tone="success">{notice}</Alert></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total staff" value={stats.total} />
        <StatTile label="Active" value={stats.active} tone="success" />
        <StatTile label="Employees" value={stats.employees} />
        <StatTile label="Drivers" value={stats.drivers} tone="warning" />
      </div>

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No staff yet" hint="Add your first employee to get started." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Rate/h</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grouped.map(([group, rows]) => (
                  <FragmentGroup key={group} group={group} show={branchId === 'all'}>
                    {rows.map((u) => {
                      const st = statusMap[u.id];
                      return (
                        <tr key={u.id} className="hover:bg-surface-muted">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <span className="grid h-8 w-8 place-items-center rounded-lg bg-surface-muted text-xs font-semibold text-muted">
                                {u.username.slice(0, 2).toUpperCase()}
                              </span>
                              <span className="font-medium">{u.username}</span>
                              {!u.is_active && <Badge tone="neutral">inactive</Badge>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5"><Badge tone={ROLE_TONE[u.role]}>{u.role.toLowerCase()}</Badge></td>
                          <td className="tabular px-4 py-2.5">{u.role === 'ADMIN' ? '—' : centsToUsd(u.hourly_rate_cent)}</td>
                          <td className="px-4 py-2.5">
                            {st ? <StatusChip st={st} /> : <span className="text-xs text-muted">—</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" variant="secondary" onClick={() => { setErr(null); setEditUser(u); }}>Edit</Button>
                              {u.role !== 'ADMIN' && (
                                <Button size="sm" variant="secondary" onClick={() => setSchedUser(u)}>Schedule</Button>
                              )}
                              <Button size="sm" variant="ghost" onClick={() => resetPw(u)}>Reset PW</Button>
                              <Button size="sm" variant="ghost" onClick={() => toggleActive(u)}>
                                {u.is_active ? 'Deactivate' : 'Activate'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </FragmentGroup>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {createOpen && (
        <CreateEmployeeModal
          branches={branches}
          onClose={() => setCreateOpen(false)}
          onCreated={(username, pw) => { setCreateOpen(false); setTempPw({ username, pw }); load(); }}
        />
      )}
      {editUser && (
        <EditEmployeeModal
          user={editUser}
          branches={branches}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); setNotice('Employee updated.'); load(); }}
        />
      )}
      {schedUser && (
        <ScheduleModal user={schedUser} onClose={() => setSchedUser(null)} onSaved={() => { setSchedUser(null); setNotice('Schedule saved.'); }} />
      )}
      {tempPw && (
        <Modal title="Temporary password" onClose={() => setTempPw(null)} footer={<Button onClick={() => setTempPw(null)}>Done</Button>}>
          <p className="text-sm text-muted">Share this with <b className="text-content">{tempPw.username}</b> — they'll be asked to change it on first login.</p>
          <div className="mt-3 rounded-lg border border-border bg-surface-muted px-4 py-3 text-center font-mono text-lg">{tempPw.pw}</div>
        </Modal>
      )}
    </>
  );
}

function FragmentGroup({ group, show, children }: { group: string; show: boolean; children: React.ReactNode }) {
  return (
    <>
      {show && (
        <tr><td colSpan={5} className="bg-surface-muted px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-muted">{group}</td></tr>
      )}
      {children}
    </>
  );
}

function StatusChip({ st }: { st: Status }) {
  if (st.status === 'IN') return <Badge tone="success">In · {fmt(st.since_min)}</Badge>;
  if (st.status === 'ON_TRIP') return <Badge tone="warning">On trip{st.over ? ' · over' : ''}</Badge>;
  if (st.status === 'DAY_OFF') return <Badge tone="neutral">Day off</Badge>;
  return <Badge tone="danger">Absent</Badge>;
}
function fmt(min: number) { const h = Math.floor(min / 60); return h ? `${h}h ${min % 60}m` : `${min}m`; }

function CreateEmployeeModal({ branches, onClose, onCreated }: { branches: Branch[]; onClose: () => void; onCreated: (u: string, pw: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('EMPLOYEE');
  const [branch, setBranch] = useState(branches[0]?.id ?? '');
  const [rate, setRate] = useState('2.00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await apiSend<{ temp_password: string }>('/api/admin/users', {
      idempotent: true, idemPrefix: 'user-create',
      body: {
        username, password, role,
        branchId: role === 'ADMIN' ? null : branch,
        hourlyRateCent: Math.round(parseFloat(rate || '0') * 100),
      },
    });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onCreated(username, res.data.temp_password);
  }

  return (
    <Modal title="Add employee" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="create-emp" type="submit" loading={busy}>Create</Button></>}>
      <form id="create-emp" onSubmit={submit} className="space-y-4">
        <Field label="Username" htmlFor="cu"><Input id="cu" value={username} onChange={(e) => setUsername(e.target.value)} required autoCapitalize="none" /></Field>
        <Field label="Temporary password" htmlFor="cp" hint="Share verbally; they change it on first login."><Input id="cp" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Field label="Role" htmlFor="cr">
          <Select id="cr" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="EMPLOYEE">Employee</option><option value="DRIVER">Driver</option><option value="ADMIN">Admin</option>
          </Select>
        </Field>
        {role !== 'ADMIN' && (
          <Field label="Branch" htmlFor="cb">
            <Select id="cb" value={branch} onChange={(e) => setBranch(e.target.value)} required>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        )}
        {role !== 'ADMIN' && (
          <Field label="Hourly rate (USD)" htmlFor="crate"><Input id="crate" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} required /></Field>
        )}
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}

function EditEmployeeModal({ user, branches, onClose, onSaved }: { user: User; branches: Branch[]; onClose: () => void; onSaved: () => void }) {
  const [role, setRole] = useState<Role>(user.role);
  const [branch, setBranch] = useState(user.branch_id ?? branches[0]?.id ?? '');
  const [rate, setRate] = useState((user.hourly_rate_cent / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await apiSend(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: { role, branchId: role === 'ADMIN' ? null : branch, hourlyRateCent: Math.round(parseFloat(rate || '0') * 100) },
    });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onSaved();
  }

  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="edit-emp" type="submit" loading={busy}>Save</Button></>}>
      <form id="edit-emp" onSubmit={submit} className="space-y-4">
        <Field label="Role" htmlFor="er">
          <Select id="er" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="EMPLOYEE">Employee</option><option value="DRIVER">Driver</option><option value="ADMIN">Admin</option>
          </Select>
        </Field>
        {role !== 'ADMIN' && (
          <Field label="Branch" htmlFor="eb">
            <Select id="eb" value={branch} onChange={(e) => setBranch(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        )}
        {role !== 'ADMIN' && (
          <Field label="Hourly rate (USD)" htmlFor="erate" hint="A rate change applies from now on; past shifts keep the old rate.">
            <Input id="erate" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        )}
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}

interface DayState { wd: number; name: string; working: boolean; start: string; end: string }
function ScheduleModal({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const [days, setDays] = useState<DayState[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const r = await apiGet<{ weeklySchedule: { weekday: number; start_time: string; end_time: string }[] }>(`/api/admin/schedules/${user.id}`);
      const byWd = new Map((r.ok ? r.data.weeklySchedule : []).map((s) => [s.weekday, s]));
      setDays(DAYS.map((d) => {
        const s = byWd.get(d.wd);
        return { wd: d.wd, name: d.name, working: !!s, start: s?.start_time ?? '09:00', end: s?.end_time ?? '18:00' };
      }));
    })();
  }, [user.id]);

  async function save() {
    if (!days) return;
    setBusy(true); setErr(null);
    const weeklySchedule = days.filter((d) => d.working).map((d) => ({ weekday: d.wd, start_time: d.start, end_time: d.end }));
    const res = await apiSend(`/api/admin/schedules/${user.id}`, { method: 'PUT', body: { weeklySchedule } });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onSaved();
  }

  function set(wd: number, patch: Partial<DayState>) {
    setDays((ds) => ds!.map((d) => (d.wd === wd ? { ...d, ...patch } : d)));
  }

  return (
    <Modal title={`Weekly schedule · ${user.username}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!days}>Save schedule</Button></>}>
      {!days ? (
        <div className="grid place-items-center py-8"><Spinner /></div>
      ) : (
        <div className="space-y-2">
          {days.map((d) => (
            <div key={d.wd} className="flex items-center gap-3">
              <span className="w-24 text-sm font-medium">{d.name}</span>
              <button
                type="button"
                onClick={() => set(d.wd, { working: !d.working })}
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${d.working ? 'border-success/30 bg-success-subtle text-success' : 'border-border bg-surface-muted text-muted'}`}
              >
                {d.working ? 'Working' : 'Off'}
              </button>
              <div className={`flex items-center gap-2 ${d.working ? '' : 'pointer-events-none opacity-40'}`}>
                <Input type="time" value={d.start} onChange={(e) => set(d.wd, { start: e.target.value })} className="w-auto" />
                <span className="text-xs text-muted">to</span>
                <Input type="time" value={d.end} onChange={(e) => set(d.wd, { end: e.target.value })} className="w-auto" />
              </div>
            </div>
          ))}
          {err && <Alert tone="danger">{err}</Alert>}
        </div>
      )}
    </Modal>
  );
}
