'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend, errorMessage, formatBeirut } from '@/lib/api';
import {
  PageHeader, Card, CardHeader, Badge, Button, Modal, Field, Input, Select, EmptyState, Alert, Spinner,
} from '@/components/ui';

interface Punch {
  id: string;
  branch_id: string;
  kind: 'IN' | 'OUT';
  at: string;
  lat: number;
  lng: number;
  accuracy_m: number;
  corrected: boolean;
  correction_reason: string | null;
  system_generated: boolean;
  user: { id: string; username: string };
  branch: { name: string };
}
interface Branch { id: string; name: string; deleted_at?: string | null }
interface Staff { id: string; username: string; name: string | null; role: string; branch_id: string | null; is_active: boolean }

export default function AdminPunchesPage() {
  const [punches, setPunches] = useState<Punch[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('all');
  const [userId, setUserId] = useState('all');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(200);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Punch | null>(null);
  const [corrAt, setCorrAt] = useState('');
  const [corrBranch, setCorrBranch] = useState('');
  const [corrReason, setCorrReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (branchId !== 'all') params.set('branchId', branchId);
    if (userId !== 'all') params.set('userId', userId);
    const q = params.toString() ? `?${params}` : '';
    const [p, b, u] = await Promise.all([
      apiGet<{ punches: Punch[]; has_more: boolean; limit: number }>(`/api/admin/punches${q}`),
      apiGet<{ branches: Branch[] }>('/api/admin/branches'),
      apiGet<{ users: Staff[] }>('/api/admin/users'),
    ]);
    if (p.ok) {
      setPunches(p.data.punches);
      setHasMore(p.data.has_more);
      setLimit(p.data.limit);
    }
    if (b.ok) setBranches(b.data.branches);
    if (u.ok) setStaff(u.data.users.filter((x) => x.role === 'EMPLOYEE' || x.role === 'DRIVER'));
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, userId]);

  // The branch filter narrows the employee list, but never hides somebody who
  // is currently selected - a roaming employee can be picked while looking at
  // one branch and then have punches at another, and losing them from the
  // dropdown mid-filter would look like the app forgetting who you chose.
  const staffOptions = staff
    .filter((x) => branchId === 'all' || x.branch_id === branchId || x.id === userId)
    .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));

  function openCorrect(p: Punch) {
    setTarget(p);
    setCorrAt(p.at.slice(0, 16));
    setCorrBranch(p.branch_id);
    setCorrReason('');
    setErr(null);
    setSuccess(null);
  }

  async function submitCorrect(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setErr(null);
    const res = await apiSend('/api/admin/punches/correct', {
      idempotent: true,
      idemPrefix: 'correct',
      body: {
        punchId: target.id,
        newAt: new Date(corrAt).toISOString(),
        newBranchId: corrBranch || undefined,
        reason: corrReason,
      },
    });
    setBusy(false);
    if (!res.ok) {
      setErr(errorMessage(res));
      return;
    }
    setTarget(null);
    setSuccess('Punch corrected.');
    await load();
  }

  return (
    <>
      <PageHeader
        title="Punches"
        subtitle="Attendance log with GPS evidence"
        actions={
          <div className="flex flex-wrap gap-2">
            <Select
              value={branchId}
              onChange={(e) => { setBranchId(e.target.value); setUserId('all'); }}
              className="w-auto"
            >
              <option value="all">All branches</option>
              {/* Closed branches stay here on purpose: their punches are still
                  in this log, and filtering to them is exactly what a record is
                  for. They are marked so nobody assigns anybody to one. */}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}{b.deleted_at ? ' (closed)' : ''}
                </option>
              ))}
            </Select>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-auto">
              <option value="all">Everyone</option>
              {staffOptions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name || x.username}{x.is_active ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {success && <div className="mb-3"><Alert tone="success">{success}</Alert></div>}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : punches.length === 0 ? (
        <EmptyState title="No punches" hint="Check-ins and check-outs will appear here." />
      ) : (
        <Card>
          <CardHeader
            title="Recent punches"
            subtitle={
              hasMore
                ? `Newest ${punches.length} shown — there are older ones not listed. Narrow by employee to see further back.`
                : `${punches.length} shown`
            }
          />
          {hasMore && (
            <div className="border-b border-border px-4 py-2.5">
              <Alert tone="warning">
                Only the newest {limit} punches are listed. Pick one employee above to see the rest
                of theirs.
              </Alert>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5">Employee</th>
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Kind</th>
                  <th className="px-4 py-2.5">Time (Beirut)</th>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-4 py-2.5">Accuracy</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {punches.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-muted">
                    <td className="px-4 py-2.5 font-medium">{p.user.username}</td>
                    <td className="px-4 py-2.5">{p.branch.name}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={p.kind === 'IN' ? 'success' : 'neutral'}>{p.kind}</Badge>
                      {p.corrected && <span className="ml-1"><Badge tone="warning">corrected</Badge></span>}
                      {p.system_generated && (
                        <span className="ml-1" title="Written by the system to close a forgotten check-in at that day's shift hours. Correct it if the real hours differ.">
                          <Badge tone="warning">auto</Badge>
                        </span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 text-xs">{formatBeirut(p.at)}</td>
                    <td className="tabular px-4 py-2.5 text-xs text-muted">
                      {p.system_generated ? 'no GPS - system punch' : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}
                    </td>
                    <td className="tabular px-4 py-2.5 text-xs">{p.accuracy_m}m</td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="sm" variant="secondary" onClick={() => openCorrect(p)}>Correct</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {target && (
        <Modal
          title="Correct punch"
          onClose={() => setTarget(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button>
              <Button form="correct-form" type="submit" loading={busy}>Save correction</Button>
            </>
          }
        >
          <form id="correct-form" onSubmit={submitCorrect} className="space-y-4">
            <p className="text-xs text-muted">
              {target.user.username} · original {formatBeirut(target.at)}
            </p>
            <Field label="New time (Beirut)" htmlFor="corrAt">
              <Input id="corrAt" type="datetime-local" value={corrAt} onChange={(e) => setCorrAt(e.target.value)} required />
            </Field>
            <Field label="Branch" htmlFor="corrBranch">
              <Select id="corrBranch" value={corrBranch} onChange={(e) => setCorrBranch(e.target.value)}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label="Reason" htmlFor="corrReason">
              <Input id="corrReason" value={corrReason} onChange={(e) => setCorrReason(e.target.value)}
                placeholder="e.g. employee forgot to punch out" required maxLength={500} />
            </Field>
            {err && <Alert tone="danger">{err}</Alert>}
          </form>
        </Modal>
      )}
    </>
  );
}
