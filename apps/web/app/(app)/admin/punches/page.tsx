'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend, errorMessage, formatBeirut } from '@/lib/api';
import {
  PageHeader, Card, CardHeader, Badge, Button, Modal, Field, Input, Select, EmptyState, Alert, Spinner,
} from '@/components/ui';
import { PunchCards } from '@/components/admin/PunchCards';

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
  const [revokeTarget, setRevokeTarget] = useState<Punch | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
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

  function openRevoke(p: Punch) {
    setRevokeTarget(p);
    setRevokeReason('');
    setErr(null);
    setSuccess(null);
  }

  async function submitRevoke(e: React.FormEvent) {
    e.preventDefault();
    if (!revokeTarget) return;
    setBusy(true);
    setErr(null);
    const res = await apiSend('/api/admin/punches/revoke-auto-close', {
      idempotent: true,
      idemPrefix: 'revoke-auto-close',
      body: { punchId: revokeTarget.id, reason: revokeReason },
    });
    setBusy(false);
    if (!res.ok) {
      setErr(errorMessage(res));
      return;
    }
    setRevokeTarget(null);
    setSuccess('Checkout revoked. The shift is open again - their own punch-out will close it.');
    await load();
  }

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
          <>
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
          </>
        }
      />

      {success && <div className="mb-3"><Alert tone="success">{success}</Alert></div>}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : punches.length === 0 ? (
        <EmptyState title="No punches" hint="Check-ins and check-outs will appear here." />
      ) : (
        <>
        {/* A phone gets one card per punch; the table is for md and up. */}
        <div className="md:hidden">
          <p className="mb-2 px-1 text-xs text-muted">
            {hasMore
              ? `Newest ${punches.length} shown — pick one employee above to see further back.`
              : `${punches.length} shown`}
          </p>
          <PunchCards punches={punches} on={{ correct: openCorrect, revoke: openRevoke }} />
        </div>
        <Card className="hidden md:block">
          <CardHeader
            title="Recent punches"
            subtitle={
              hasMore
                ? `Newest ${punches.length} shown — there are older ones not listed. Narrow by employee to see further back.`
                : `${punches.length} shown`
            }
          />
          {/* The card subtitle already says the list is cut and how to see
              more; a second banner saying it again was noise. `limit` is what
              the subtitle counts. */}
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr className="text-left">
                  <th>Employee</th>
                  <th>Branch</th>
                  <th>Kind</th>
                  <th>Time (Beirut)</th>
                  <th>Location</th>
                  <th>Accuracy</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {punches.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">{p.user.username}</td>
                    <td>{p.branch.name}</td>
                    <td>
                      <Badge tone={p.kind === 'IN' ? 'success' : 'neutral'}>{p.kind}</Badge>
                      {p.corrected && <span className="ml-1"><Badge tone="warning">corrected</Badge></span>}
                      {p.system_generated && (
                        <span className="ml-1" title="Written by the system after 20h with no checkout, at that day's shift hours. If they were covering a double and really were still there, Revoke it and their own punch-out will count.">
                          <Badge tone="warning">auto</Badge>
                        </span>
                      )}
                    </td>
                    <td className="tabular text-xs">{formatBeirut(p.at)}</td>
                    <td className="tabular text-xs text-muted">
                      {p.system_generated ? 'no GPS - system punch' : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}
                    </td>
                    <td className="tabular text-xs">{p.accuracy_m}m</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        {p.system_generated && p.kind === 'OUT' && (
                          <Button size="sm" variant="secondary" onClick={() => openRevoke(p)}>Revoke</Button>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => openCorrect(p)}>Correct</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        </>
      )}

      {revokeTarget && (
        <Modal
          title="Revoke system checkout"
          onClose={() => setRevokeTarget(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRevokeTarget(null)}>Cancel</Button>
              <Button form="revoke-form" type="submit" variant="danger" loading={busy}>Revoke checkout</Button>
            </>
          }
        >
          <form id="revoke-form" onSubmit={submitRevoke} className="space-y-4">
            <p className="text-sm">
              The system wrote this checkout for <strong>{revokeTarget.user.username}</strong> at{' '}
              {formatBeirut(revokeTarget.at)}, because their check-in had been open for more than 20 hours.
            </p>
            <p className="text-xs text-muted">
              Revoking deletes it and leaves the shift open, so their own punch-out is what closes it - at
              the hour they actually left. The system will not write another checkout for this shift.
              Use this when they were covering a double, not when they simply forgot.
            </p>
            <Field label="Reason" htmlFor="revokeReason">
              <Input
                id="revokeReason"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="Covering a double shift"
                required
              />
            </Field>
          </form>
        </Modal>
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
