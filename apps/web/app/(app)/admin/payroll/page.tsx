'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiSend, centsToUsd, csrfFromCookie, errorMessage } from '@/lib/api';
import { PageHeader, Card, Button, Modal, Field, Input, Select, EmptyState, Alert, Spinner, StatTile } from '@/components/ui';

interface Row {
  user_id: string;
  username: string;
  role: string;
  branch_id: string | null;
  branch_name: string | null;
  rate_cent: number;
  // Reference only — what the owner expects to pay this person monthly. Never
  // part of any total; shown next to net pay so he can eyeball the gap himself.
  expected_salary_cent: number | null;
  hours: number;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
  overtime_deduction_cent: number;
  net_cent: number;
}
interface Totals {
  hours: number;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
  overtime_deduction_cent: number;
  net_cent: number;
}
interface Branch { id: string; name: string }

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function AdminPayrollPage() {
  const [month, setMonth] = useState(currentMonth());
  const [branchId, setBranchId] = useState('all');
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<Row | null>(null);
  const [rateFor, setRateFor] = useState<Row | null>(null);
  const [penaltiesFor, setPenaltiesFor] = useState<Row | null>(null);
  const [overtimeFor, setOvertimeFor] = useState<Row | null>(null);
  const [salaryFor, setSalaryFor] = useState<Row | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    const r = await apiGet<{ rows: Row[]; totals: Totals; branches: Branch[] }>(`/api/admin/payroll?month=${month}&branchId=${branchId}`);
    if (r.ok) {
      setRows(r.data.rows);
      setTotals(r.data.totals);
      setBranches(r.data.branches);
    } else {
      setErr(errorMessage(r));
    }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [month, branchId]);

  const grouped = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.branch_name ?? 'Unassigned';
      (g.get(key) ?? g.set(key, []).get(key)!).push(r);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  async function downloadPdf() {
    setDownloading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/reports/payroll?month=${month}&branchId=${branchId}`, {
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrfFromCookie() },
      });
      if (!res.ok) { setErr('Could not generate PDF.'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `payroll-${month}${branchId !== 'all' ? '-branch' : ''}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Payroll"
        subtitle="Hours, pay, adjustments and advances for the month"
        actions={
          <>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-auto" />
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
              <option value="all">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Button onClick={downloadPdf} loading={downloading}>📄 PDF</Button>
          </>
        }
      />

      {msg && <div className="mb-3"><Alert tone="success">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}

      {totals && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <StatTile label="Total to pay" value={centsToUsd(totals.net_cent)} tone="primary" hint="Wages + bonuses − deductions − advances − penalties − revoked overtime" />
          <StatTile label="Gross wages" value={centsToUsd(totals.gross_cent)} />
          <StatTile
            label="Adjustments"
            value={totals.adjustments_cent === 0 ? '$0.00' : `${totals.adjustments_cent > 0 ? '+' : '−'}${centsToUsd(Math.abs(totals.adjustments_cent))}`}
            tone={totals.adjustments_cent > 0 ? 'success' : totals.adjustments_cent < 0 ? 'danger' : 'neutral'}
          />
          <StatTile label="Penalties" value={totals.penalties_cent === 0 ? '$0.00' : `−${centsToUsd(totals.penalties_cent)}`} tone={totals.penalties_cent > 0 ? 'danger' : 'neutral'} />
          <StatTile
            label="Overtime revoked"
            value={totals.overtime_deduction_cent === 0 ? '$0.00' : `−${centsToUsd(totals.overtime_deduction_cent)}`}
            tone={totals.overtime_deduction_cent > 0 ? 'danger' : 'neutral'}
          />
          <StatTile label="Advances" value={centsToUsd(totals.advances_cent)} tone={totals.advances_cent > 0 ? 'danger' : 'neutral'} />
          <StatTile label="Hours" value={totals.hours.toFixed(1)} />
        </div>
      )}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : rows.length === 0 ? (
        <EmptyState title="No payroll data" hint="No active staff for this month/branch." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 text-left">Employee</th>
                  <th className="px-4 py-2.5 text-right">Hours</th>
                  <th className="px-4 py-2.5 text-right">Rate</th>
                  <th className="px-4 py-2.5 text-right">Gross</th>
                  <th className="px-4 py-2.5 text-right">Adjust.</th>
                  <th className="px-4 py-2.5 text-right">Penalty</th>
                  <th className="px-4 py-2.5 text-right">OT revoked</th>
                  <th className="px-4 py-2.5 text-right">Advances</th>
                  <th className="px-4 py-2.5 text-right">Net</th>
                  <th className="px-4 py-2.5 text-right">Expected</th>
                  <th className="px-4 py-2.5 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grouped.map(([group, grows]) => (
                  <GroupBody key={group} group={group} show={branchId === 'all'}>
                    {grows.map((r) => (
                      <tr key={r.user_id} className="hover:bg-surface-muted">
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{r.username}</div>
                          <div className="text-xs text-muted">{r.role.toLowerCase()}</div>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">{r.hours.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => setRateFor(r)}
                            className="tabular border-b border-dashed border-primary/50 font-medium hover:text-primary"
                            title="Change hourly rate"
                          >
                            {centsToUsd(r.rate_cent)}
                          </button>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">{centsToUsd(r.gross_cent)}</td>
                        <td className={`tabular px-4 py-2.5 text-right font-medium ${r.adjustments_cent > 0 ? 'text-success' : r.adjustments_cent < 0 ? 'text-danger' : 'text-muted'}`}>
                          {r.adjustments_cent === 0 ? '—' : `${r.adjustments_cent > 0 ? '+' : '−'}${centsToUsd(Math.abs(r.adjustments_cent), false)}`}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => setPenaltiesFor(r)}
                            className={`tabular border-b border-dashed border-danger/40 font-medium hover:text-danger ${r.penalties_cent > 0 ? 'text-danger' : 'text-muted'}`}
                            title="View / remove penalties"
                          >
                            {r.penalties_cent === 0 ? '—' : `−${centsToUsd(r.penalties_cent, false)}`}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => setOvertimeFor(r)}
                            className={`tabular border-b border-dashed border-warning/40 font-medium hover:text-warning ${r.overtime_deduction_cent > 0 ? 'text-danger' : 'text-muted'}`}
                            title="View overtime / undo a decision"
                          >
                            {r.overtime_deduction_cent === 0 ? '—' : `−${centsToUsd(r.overtime_deduction_cent, false)}`}
                          </button>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right text-danger">
                          {r.advances_cent === 0 ? <span className="text-muted">—</span> : `−${centsToUsd(r.advances_cent, false)}`}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right font-semibold">{centsToUsd(r.net_cent)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => setSalaryFor(r)}
                            className="tabular border-b border-dashed border-border font-medium hover:text-primary"
                            title="Set expected monthly salary (reference only — never affects pay)"
                          >
                            {r.expected_salary_cent == null ? <span className="text-muted">—</span> : centsToUsd(r.expected_salary_cent)}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => setAdjust(r)}>＋ Adjust</Button>
                        </td>
                      </tr>
                    ))}
                  </GroupBody>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-surface-muted font-semibold">
                    <td className="px-4 py-3 text-left text-xs uppercase tracking-wide text-muted">Total · {rows.length} staff</td>
                    <td className="tabular px-4 py-3 text-right">{totals.hours.toFixed(1)}</td>
                    <td></td>
                    <td className="tabular px-4 py-3 text-right">{centsToUsd(totals.gross_cent)}</td>
                    <td className="tabular px-4 py-3 text-right">{totals.adjustments_cent >= 0 ? '+' : '−'}{centsToUsd(Math.abs(totals.adjustments_cent), false)}</td>
                    <td className="tabular px-4 py-3 text-right text-danger">{totals.penalties_cent === 0 ? '—' : `−${centsToUsd(totals.penalties_cent, false)}`}</td>
                    <td className="tabular px-4 py-3 text-right text-danger">{totals.overtime_deduction_cent === 0 ? '—' : `−${centsToUsd(totals.overtime_deduction_cent, false)}`}</td>
                    <td className="tabular px-4 py-3 text-right">−{centsToUsd(totals.advances_cent, false)}</td>
                    <td className="tabular px-4 py-3 text-right">{centsToUsd(totals.net_cent)}</td>
                    {/* Reference-only figures are never summed — left blank rather than implying a total. */}
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}

      {adjust && (
        <AdjustModal row={adjust} onClose={() => setAdjust(null)} onSaved={() => { setAdjust(null); setMsg('Adjustment added.'); load(); }} />
      )}
      {rateFor && (
        <RateModal row={rateFor} onClose={() => setRateFor(null)} onSaved={() => { setRateFor(null); setMsg('Rate updated (applies from now on).'); load(); }} />
      )}
      {penaltiesFor && (
        <PenaltiesModal row={penaltiesFor} month={month} onClose={() => setPenaltiesFor(null)} onChanged={() => { setMsg('Penalty updated.'); load(); }} />
      )}
      {overtimeFor && (
        <OvertimeModal row={overtimeFor} month={month} onClose={() => setOvertimeFor(null)} onChanged={() => { setMsg('Overtime updated.'); load(); }} />
      )}
      {salaryFor && (
        <SalaryModal row={salaryFor} onClose={() => setSalaryFor(null)} onSaved={() => { setSalaryFor(null); setMsg('Expected salary updated.'); load(); }} />
      )}
    </>
  );
}

function GroupBody({ group, show, children }: { group: string; show: boolean; children: React.ReactNode }) {
  return (
    <>
      {show && <tr><td colSpan={11} className="bg-surface-muted px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-muted">{group}</td></tr>}
      {children}
    </>
  );
}

function AdjustModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'BONUS' | 'DEDUCTION'>('BONUS');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await apiSend('/api/admin/adjustments', {
      idempotent: true, idemPrefix: 'adj',
      body: { userId: row.user_id, kind, amountCent: Math.round(parseFloat(amount || '0') * 100), reason },
    });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onSaved();
  }
  return (
    <Modal title={`Adjust pay · ${row.username}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="adj" type="submit" loading={busy}>Add</Button></>}>
      <form id="adj" onSubmit={submit} className="space-y-4">
        <Field label="Type" htmlFor="ak">
          <Select id="ak" value={kind} onChange={(e) => setKind(e.target.value as 'BONUS' | 'DEDUCTION')}>
            <option value="BONUS">Bonus (+)</option>
            <option value="DEDUCTION">Deduction (−)</option>
          </Select>
        </Field>
        <Field label="Amount (USD)" htmlFor="aa"><Input id="aa" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Reason" htmlFor="ar"><Input id="ar" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} placeholder="e.g. Eid bonus" /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}

interface PenaltyItem {
  date: string;
  kind: 'SHORTFALL';
  shortfallMin: number;
  penaltyMin: number;
  rate_cent: number;
  amount_cent: number;
  waived: boolean;
  waiverStale: boolean;
}

function PenaltiesModal({ row, month, onClose, onChanged }: { row: Row; month: string; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<PenaltyItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Restore deletes the owner's removal and starts a deduction, so it arms
  // first like every other irreversible action in this app.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await apiGet<{ penalties: PenaltyItem[] }>(`/api/admin/penalties?userId=${row.user_id}&month=${month}`);
    if (r.ok) setItems(r.data.penalties);
    else setErr(errorMessage(r));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function setWaived(p: PenaltyItem, waived: boolean) {
    const id = `${p.date}|${p.kind}`;
    // Keyed per action, not per row: two buttons sharing one key spin together
    // and neither says which one is running.
    setBusy(`${id}|${waived ? 'remove' : 'restore'}`); setErr(null);
    const res = await apiSend('/api/admin/penalties/waive', {
      // This modal does not poll, so a punch corrected while it sits open can
      // move the figure on screen. Sending it lets the server refuse a ruling
      // made against an amount the day no longer has.
      body: { userId: row.user_id, date: p.date, kind: p.kind, waived, penaltyMin: p.penaltyMin },
    });
    setBusy(null);
    setConfirming(null);
    if (!res.ok) {
      setErr(errorMessage(res));
      await load(); // the refused ruling means the list is out of date - show the new figure
      return;
    }
    setItems((prev) => prev?.map((x) => (x.date === p.date && x.kind === p.kind ? { ...x, waived, waiverStale: false } : x)) ?? null);
    onChanged();
  }

  return (
    <Modal title={`Penalties · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-sm text-muted">
        Automatic penalties for covering fewer hours than the day required: double the shortfall is
        docked, never more than the day itself earned. Remove one when the employee gave notice —
        this never affects manual adjustments. A removal keeps holding even after a punch is
        corrected; it is flagged here for a second look rather than quietly undone.
      </p>
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}
      {items === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState title="No penalties" hint="This employee has no shortfall penalties this month." />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((p) => {
            const id = `${p.date}|${p.kind}`;
            return (
              <li key={id} className="flex items-center justify-between gap-3 py-2.5">
                <div className={p.waived ? 'opacity-50' : ''}>
                  <div className="text-sm font-medium">
                    Hours short · <span className="tabular">{p.shortfallMin} min</span>
                    {p.waived && <span className="ml-2 text-xs font-normal text-muted">(removed)</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {/* Not written as minutes x rate: the amount is clamped to what
                        the day earned, so on a day split by a mid-shift raise the
                        equation would not add up on screen. */}
                    {p.date} · {p.penaltyMin} min docked · <span className="text-danger">−{centsToUsd(p.amount_cent)}</span>
                  </div>
                  {p.waived && p.waiverStale && (
                    <div className="mt-1 text-xs text-warning">
                      This day has changed since you removed it. Still nothing docked — confirm the removal at
                      this figure, or restore the penalty.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {p.waived && p.waiverStale && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `${id}|remove`}
                      onClick={() => setWaived(p, true)}
                    >
                      Confirm removal
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={confirming === id ? 'danger' : p.waived ? 'secondary' : 'ghost'}
                    loading={busy === (p.waived ? `${id}|restore` : `${id}|remove`)}
                    onClick={() => {
                      if (p.waived && confirming !== id) {
                        setConfirming(id);
                        return;
                      }
                      void setWaived(p, !p.waived);
                    }}
                  >
                    {p.waived ? (confirming === id ? 'Tap again to dock it' : 'Restore') : 'Remove'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

interface OvertimeItem {
  date: string;
  overtimeMin: number;
  rate_cent: number;
  amount_cent: number;
  decision: 'ACCEPTED' | 'REVOKED' | null;
}

function overtimeState(d: OvertimeItem['decision']): { label: string; tone: string } {
  if (d === 'REVOKED') return { label: 'Revoked — deducted', tone: 'text-danger' };
  if (d === 'ACCEPTED') return { label: 'Accepted — paid', tone: 'text-success' };
  return { label: 'Pending — paid', tone: 'text-muted' };
}

// The attention queue drops a day the moment it has a decision, so this modal is
// the only place a decided day can be found again — and the only way back from a
// mis-clicked Revoke short of editing the database.
function OvertimeModal({ row, month, onClose, onChanged }: { row: Row; month: string; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<OvertimeItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await apiGet<{ overtime: OvertimeItem[] }>(`/api/admin/overtime?userId=${row.user_id}&month=${month}`);
    if (r.ok) setItems(r.data.overtime);
    else setErr(errorMessage(r));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function decide(o: OvertimeItem, decision: 'ACCEPTED' | 'REVOKED' | 'PENDING') {
    const id = `${o.date}|${decision}`;
    setBusy(id); setErr(null);
    const res = await apiSend('/api/admin/overtime/decision', {
      idempotent: true, idemPrefix: 'ot',
      // This modal does not poll, so the figure on screen can go stale while it
      // sits open. Sending it lets the server refuse a ruling made against an
      // amount that no longer exists rather than silently deducting the new one.
      body: { userId: row.user_id, date: o.date, decision, overtimeMin: o.overtimeMin },
    });
    setBusy(null);
    if (!res.ok) {
      setErr(errorMessage(res));
      await load(); // the refused ruling means the list is out of date - show the new figure
      return;
    }
    setItems((prev) => prev?.map((x) => (x.date === o.date ? { ...x, decision: decision === 'PENDING' ? null : decision } : x)) ?? null);
    onChanged();
  }

  return (
    <Modal title={`Overtime · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-sm text-muted">
        Every day worked past its scheduled hours. Overtime is paid automatically, so a pending day
        is already in their pay — revoking one deducts it. Undo puts a day back to pending.
      </p>
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}
      {items === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState title="No overtime" hint="This employee has no overtime this month." />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((o) => {
            const state = overtimeState(o.decision);
            return (
              <li key={o.date} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <div className="text-sm font-medium">
                    Over by <span className="tabular">{o.overtimeMin} min</span>
                  </div>
                  <div className="text-xs text-muted">
                    {o.date} · {centsToUsd(o.amount_cent)} · <span className={state.tone}>{state.label}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {o.decision === null ? (
                    <>
                      <Button size="sm" variant="secondary" loading={busy === `${o.date}|ACCEPTED`} onClick={() => decide(o, 'ACCEPTED')}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" loading={busy === `${o.date}|REVOKED`} onClick={() => decide(o, 'REVOKED')}>
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" loading={busy === `${o.date}|PENDING`} onClick={() => decide(o, 'PENDING')}>
                      Undo
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

function RateModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [rate, setRate] = useState((row.rate_cent / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await apiSend(`/api/admin/users/${row.user_id}`, {
      method: 'PATCH',
      body: { hourlyRateCent: Math.round(parseFloat(rate || '0') * 100) },
    });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onSaved();
  }
  return (
    <Modal title={`Hourly rate · ${row.username}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="rate" type="submit" loading={busy}>Save rate</Button></>}>
      <form id="rate" onSubmit={submit} className="space-y-4">
        <Field label="New hourly rate (USD)" htmlFor="rr" hint="Applies from now on; hours already worked this month keep the old rate.">
          <Input id="rr" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} required />
        </Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}

function SalaryModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [salary, setSalary] = useState(row.expected_salary_cent != null ? (row.expected_salary_cent / 100).toFixed(2) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const trimmed = salary.trim();
    const res = await apiSend(`/api/admin/users/${row.user_id}`, {
      method: 'PATCH',
      body: { expectedMonthlySalaryCent: trimmed === '' ? null : Math.round(parseFloat(trimmed) * 100) },
    });
    setBusy(false);
    if (!res.ok) { setErr(errorMessage(res)); return; }
    onSaved();
  }
  return (
    <Modal title={`Expected monthly salary · ${row.username}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="salary" type="submit" loading={busy}>Save</Button></>}>
      <form id="salary" onSubmit={submit} className="space-y-4">
        <Field
          label="Expected monthly salary (USD)"
          htmlFor="es"
          hint="Reference only — for comparing against actual pay. Never affects payroll. Leave blank to clear."
        >
          <Input id="es" type="number" step="0.01" min="0" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="Not set" />
        </Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </form>
    </Modal>
  );
}
