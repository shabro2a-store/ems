'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiSend, centsToUsd, csrfFromCookie, errorMessage, formatBeirutTime } from '@/lib/api';
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
  // Inside gross_cent, never added to it.
  blocked_credit_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
  overtime_deduction_cent: number;
  // Drivers only. Inside gross_cent, like blocked credit - a memo, never added again.
  trips_count: number;
  trips_cent: number;
  net_cent: number;
}
interface Totals {
  hours: number;
  gross_cent: number;
  // Inside gross_cent, never added to it.
  blocked_credit_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
  overtime_deduction_cent: number;
  // Drivers only. Inside gross_cent, like blocked credit - a memo, never added again.
  trips_count: number;
  trips_cent: number;
  net_cent: number;
}
interface Branch { id: string; name: string }

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function AdminPayrollPage() {
  const [month, setMonth] = useState(currentMonth());
  // An earlier month has been paid, so nothing on top of the record may move:
  // no bonuses, no deductions, no waiving a penalty or ruling on overtime. The
  // punches themselves stay correctable on the Punches screen - fixing what
  // actually happened is not the same as changing what was paid on top of it.
  const closed = month < currentMonth();
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
  const [adjustmentsFor, setAdjustmentsFor] = useState<Row | null>(null);
  const [tripsFor, setTripsFor] = useState<Row | null>(null);
  const [blockedCreditFor, setBlockedCreditFor] = useState<Row | null>(null);
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
        subtitle="Net = wages (hours + trips) + bonuses − deductions − advances − penalties − revoked overtime"
        actions={
          <>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-auto" />
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
              <option value="all">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Button onClick={downloadPdf} loading={downloading}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              PDF
            </Button>
          </>
        }
      />

      {closed && (
        <div className="mb-3">
          <Alert tone="warning">
            🔒 <b>{month} is closed.</b> It has already been paid, so bonuses, deductions and
            rulings can only be made on the current month. The figures below are read-only. A punch
            that was actually wrong can still be corrected on the Punches screen.
          </Alert>
        </div>
      )}

      {msg && <div className="mb-3"><Alert tone="success">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}

      {totals && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <StatTile label="Total to pay" value={centsToUsd(totals.net_cent)} tone="primary" hint={`${rows.length} staff`} />
          <StatTile
            label="Gross wages"
            value={centsToUsd(totals.gross_cent)}
            // Inside gross, not on top of it. A gross figure that includes
            // hours nobody clocked has to say so somewhere on the screen.
            hint={totals.blocked_credit_cent > 0 ? `incl. ${centsToUsd(totals.blocked_credit_cent)} blocked time` : undefined}
          />
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
            <table className="data-table data-table--dense">
              <thead>
                <tr>
                  <th className="text-left">Employee</th>
                  <th className="text-right">Hours</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Trips</th>
                  <th className="text-right">Adjust.</th>
                  <th className="text-right">Penalty</th>
                  <th className="text-right">OT revoked</th>
                  <th className="text-right">Advances</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">Expected</th>
                  <th className="text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grouped.map(([group, grows]) => (
                  <GroupBody key={group} group={group} show={branchId === 'all'}>
                    {grows.map((r) => (
                      <tr key={r.user_id}>
                        <td>
                          <div className="font-medium">{r.username}</div>
                          <div className="text-xs text-muted">{r.role.toLowerCase()}</div>
                        </td>
                        <td className="tabular text-right">{r.hours.toFixed(1)}</td>
                        <td className="text-right">
                          <button
                            onClick={() => setRateFor(r)}
                            className="tabular border-b border-dashed border-primary/50 font-medium hover:text-primary"
                            title="Change hourly rate"
                          >
                            {centsToUsd(r.rate_cent)}
                          </button>
                        </td>
                        <td className="tabular text-right">
                          {centsToUsd(r.gross_cent)}
                          {/* Always offered, not only when something is credited:
                              the whole point of this surface is reaching a day
                              that is waiting or has gone stale, and both of those
                              contribute nothing to the figure above. */}
                          <button
                            onClick={() => setBlockedCreditFor(r)}
                            className="block w-full border-b border-dashed border-primary/40 text-right text-[11px] font-normal text-muted hover:text-primary"
                            title="Time this employee was at the branch but the app would not let them clock in. Review, accept or undo."
                          >
                            {r.blocked_credit_cent > 0 ? `incl. ${centsToUsd(r.blocked_credit_cent)} blocked` : 'blocked time'}
                          </button>
                        </td>
                        <td className="text-right">
                          {r.role === 'DRIVER' ? (
                            <button
                              onClick={() => setTripsFor(r)}
                              className="tabular whitespace-nowrap border-b border-dashed border-primary/40 font-medium hover:text-primary"
                              title="Completed deliveries this month, by working day. Already inside Gross."
                            >
                              {r.trips_count === 0 ? '—' : `${r.trips_count} · ${centsToUsd(r.trips_cent, false)}`}
                            </button>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="text-right">
                          <button
                            onClick={() => setAdjustmentsFor(r)}
                            className={`tabular border-b border-dashed font-medium ${r.adjustments_cent > 0 ? 'border-success/40 text-success hover:text-success' : r.adjustments_cent < 0 ? 'border-danger/40 text-danger hover:text-danger' : 'border-border text-muted hover:text-content'}`}
                            title="View every bonus and deduction this month, with the reason each was given"
                          >
                            {r.adjustments_cent === 0 ? '—' : `${r.adjustments_cent > 0 ? '+' : '−'}${centsToUsd(Math.abs(r.adjustments_cent), false)}`}
                          </button>
                        </td>
                        <td className="text-right">
                          <button
                            onClick={() => setPenaltiesFor(r)}
                            className={`tabular border-b border-dashed border-danger/40 font-medium hover:text-danger ${r.penalties_cent > 0 ? 'text-danger' : 'text-muted'}`}
                            title="View / remove penalties"
                          >
                            {r.penalties_cent === 0 ? '—' : `−${centsToUsd(r.penalties_cent, false)}`}
                          </button>
                        </td>
                        <td className="text-right">
                          <button
                            onClick={() => setOvertimeFor(r)}
                            className={`tabular border-b border-dashed border-warning/40 font-medium hover:text-warning ${r.overtime_deduction_cent > 0 ? 'text-danger' : 'text-muted'}`}
                            title="View overtime / undo a decision"
                          >
                            {r.overtime_deduction_cent === 0 ? '—' : `−${centsToUsd(r.overtime_deduction_cent, false)}`}
                          </button>
                        </td>
                        <td className="tabular text-right text-danger">
                          {r.advances_cent === 0 ? <span className="text-muted">—</span> : `−${centsToUsd(r.advances_cent, false)}`}
                        </td>
                        <td className="tabular text-right font-semibold">{centsToUsd(r.net_cent)}</td>
                        <td className="text-right">
                          <button
                            onClick={() => setSalaryFor(r)}
                            className="tabular border-b border-dashed border-border font-medium hover:text-primary"
                            title="Set expected monthly salary (reference only — never affects pay)"
                          >
                            {r.expected_salary_cent == null ? <span className="text-muted">—</span> : centsToUsd(r.expected_salary_cent)}
                          </button>
                        </td>
                        <td className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={closed}
                            title={closed ? `${month} is closed — adjust the current month instead.` : undefined}
                            onClick={() => setAdjust(r)}
                          >
                            ＋ Adjust
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </GroupBody>
                ))}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-surface-muted font-semibold">
                    <td className="text-left text-xs uppercase tracking-wide text-muted">Total · {rows.length} staff</td>
                    <td className="tabular text-right">{totals.hours.toFixed(1)}</td>
                    <td></td>
                    <td className="tabular text-right">{centsToUsd(totals.gross_cent)}</td>
                    <td className="tabular whitespace-nowrap text-right">{totals.trips_count === 0 ? '—' : `${totals.trips_count} · ${centsToUsd(totals.trips_cent, false)}`}</td>
                    <td className="tabular text-right">{totals.adjustments_cent >= 0 ? '+' : '−'}{centsToUsd(Math.abs(totals.adjustments_cent), false)}</td>
                    <td className="tabular text-right text-danger">{totals.penalties_cent === 0 ? '—' : `−${centsToUsd(totals.penalties_cent, false)}`}</td>
                    <td className="tabular text-right text-danger">{totals.overtime_deduction_cent === 0 ? '—' : `−${centsToUsd(totals.overtime_deduction_cent, false)}`}</td>
                    <td className="tabular text-right">−{centsToUsd(totals.advances_cent, false)}</td>
                    <td className="tabular text-right">{centsToUsd(totals.net_cent)}</td>
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
        <AdjustModal row={adjust} month={month} onClose={() => setAdjust(null)} onSaved={() => { setAdjust(null); setMsg(`Adjustment added to ${month}.`); load(); }} />
      )}
      {rateFor && (
        <RateModal row={rateFor} onClose={() => setRateFor(null)} onSaved={() => { setRateFor(null); setMsg('Rate updated (applies from now on).'); load(); }} />
      )}
      {tripsFor && (
        <TripsModal row={tripsFor} month={month} onClose={() => setTripsFor(null)} />
      )}
      {adjustmentsFor && (
        <AdjustmentsModal row={adjustmentsFor} month={month} onClose={() => setAdjustmentsFor(null)} />
      )}
      {penaltiesFor && (
        <PenaltiesModal row={penaltiesFor} closed={closed} month={month} onClose={() => setPenaltiesFor(null)} onChanged={() => { setMsg('Penalty updated.'); load(); }} />
      )}
      {blockedCreditFor && (
        <BlockedCreditModal row={blockedCreditFor} closed={closed} month={month} onClose={() => setBlockedCreditFor(null)} onChanged={() => { setMsg('Blocked time updated.'); load(); }} />
      )}
      {overtimeFor && (
        <OvertimeModal row={overtimeFor} closed={closed} month={month} onClose={() => setOvertimeFor(null)} onChanged={() => { setMsg('Overtime updated.'); load(); }} />
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
      {/* The label is sticky on its own so it stays in view while a phone
          scrolls the columns sideways - the cell is the whole row's width and
          cannot move. */}
      {show && <tr className="group-row"><td colSpan={12}><span className="sticky left-2.5">{group}</span></td></tr>}
      {children}
    </>
  );
}

function AdjustModal({ row, month, onClose, onSaved }: { row: Row; month: string; onClose: () => void; onSaved: () => void }) {
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
      // The month on screen, not the server's clock. Without it an adjustment
      // made while reviewing an earlier month landed on the current one.
      body: { userId: row.user_id, month, kind, amountCent: Math.round(parseFloat(amount || '0') * 100), reason },
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

interface TripDay {
  date: string;
  count: number;
  cent: number;
  denied: number;
  trips: Array<{
    id: string;
    out_at: string;
    back_at: string | null;
    branch: string;
    system_closed: boolean;
    rate_cent: number;
    denied: boolean;
    denied_reason: string | null;
    receipt: 'available' | 'wiped' | 'none';
  }>;
}

// Read-only. Trips are made by the driver pressing OUT and BACK, and what is
// owed for them is the count times the rate in force that day; there is no
// ruling to make here, only a record to check. The day-by-day shape is the one
// the owner asked for - "how many trips did each driver do today" - and it is
// also the shape that shows a forgotten BACK, because a trip the sweep closed
// is marked.
function TripsModal({ row, month, onClose }: { row: Row; month: string; onClose: () => void }) {
  const [days, setDays] = useState<TripDay[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ days: TripDay[] }>(`/api/admin/trips?userId=${row.user_id}&month=${month}`).then((r) => {
      if (r.ok) setDays(r.data.days);
      else setErr(errorMessage(r));
    });
  }, [row.user_id, month]);

  const total = (days ?? []).reduce((a, d) => ({ count: a.count + d.count, cent: a.cent + d.cent }), { count: 0, cent: 0 });

  return (
    <Modal size="lg" title={`Trips · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-sm text-muted">
        Every completed delivery on {month}, filed under the working day of the shift it happened in and
        priced at the per-trip rate in force when it went out. This total is already inside Gross. A trip
        closed by the system is one the driver never pressed BACK on; a denied one is a receipt you refused
        at review, and is not paid. Photos are reviewed on the Trips page.
      </p>
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}
      {days === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : days.length === 0 ? (
        <EmptyState title="No trips" hint="No completed deliveries this month." />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {days.map((d) => (
              <li key={d.date} className="py-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{d.date}</span>
                  <span className="tabular">
                    {d.count} trip{d.count === 1 ? '' : 's'}
                    {d.denied > 0 && <span className="text-danger"> ({d.denied} denied)</span>} · {centsToUsd(d.cent)}
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5 pl-3 text-xs text-muted">
                  {d.trips.map((t) => (
                    <li key={t.id} className={`flex justify-between gap-3 ${t.denied ? 'line-through decoration-danger/60' : ''}`}>
                      <span>
                        {formatBeirutTime(t.out_at)} → {t.back_at ? formatBeirutTime(t.back_at) : '…'} · {t.branch}
                        {t.system_closed && <span className="ml-1 text-warning">closed by system</span>}
                        {t.denied && <span className="ml-1 text-danger no-underline">denied{t.denied_reason ? `: ${t.denied_reason}` : ''}</span>}
                        {t.receipt === 'available' && (
                          <a href={`/api/admin/trips/${t.id}/receipt`} target="_blank" rel="noreferrer" className="ml-1 text-primary underline">
                            photo
                          </a>
                        )}
                      </span>
                      <span className="tabular shrink-0">{centsToUsd(t.rate_cent, false)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted">{total.count} trips this month</span>
            <span className="tabular font-semibold">{centsToUsd(total.cent)}</span>
          </div>
        </>
      )}
    </Modal>
  );
}

interface AdjustmentItem {
  id: string;
  kind: 'BONUS' | 'DEDUCTION';
  amount_cent: number;
  reason: string;
  created_at: string;
  created_by: string;
}

// Read-only on purpose. An adjustment is a decision with a reason attached, and
// the reason is the whole point of this list; editing one in place would let the
// figure drift away from the sentence that justified it. To change one, add
// another with its own reason - the history then says what happened and why.
function AdjustmentsModal({ row, month, onClose }: { row: Row; month: string; onClose: () => void }) {
  const [items, setItems] = useState<AdjustmentItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ adjustments: AdjustmentItem[] }>(`/api/admin/adjustments?userId=${row.user_id}&month=${month}`).then((r) => {
      if (r.ok) setItems(r.data.adjustments);
      else setErr(errorMessage(r));
    });
  }, [row.user_id, month]);

  const net = (items ?? []).reduce((s, a) => s + (a.kind === 'BONUS' ? a.amount_cent : -a.amount_cent), 0);

  return (
    <Modal size="lg" title={`Adjustments · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-3 text-sm text-muted">
        Every manual bonus and deduction on {month}, with the reason it was given. The employee
        sees this same list on their own payslip.
      </p>
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}
      {items === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState title="No adjustments" hint="Nothing has been added or deducted by hand this month." />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {items.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm">{a.reason}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {formatBeirutTime(a.created_at)} · by {a.created_by}
                  </div>
                </div>
                <div className={`tabular shrink-0 font-medium ${a.kind === 'BONUS' ? 'text-success' : 'text-danger'}`}>
                  {a.kind === 'BONUS' ? '+' : '−'}{centsToUsd(a.amount_cent)}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted">Net this month</span>
            <span className={`tabular font-semibold ${net > 0 ? 'text-success' : net < 0 ? 'text-danger' : ''}`}>
              {net >= 0 ? '+' : '−'}{centsToUsd(Math.abs(net))}
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

function PenaltiesModal({ row, month, closed, onClose, onChanged }: { row: Row; month: string; closed: boolean; onClose: () => void; onChanged: () => void }) {
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
    <Modal size="lg" title={`Penalties · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>
      {closed && (
        <div className="mb-3">
          <Alert tone="warning">
            {month} is closed — this is the record as it was paid. Nothing here can be changed.
          </Alert>
        </div>
      )}Close</Button>}>
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
function OvertimeModal({ row, month, closed, onClose, onChanged }: { row: Row; month: string; closed: boolean; onClose: () => void; onChanged: () => void }) {
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
    <Modal size="lg" title={`Overtime · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>
      {closed && (
        <div className="mb-3">
          <Alert tone="warning">
            {month} is closed — this is the record as it was paid. Nothing here can be changed.
          </Alert>
        </div>
      )}Close</Button>}>
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
                      <Button size="sm" variant="secondary" loading={busy === `${o.date}|ACCEPTED`} disabled={closed} onClick={() => decide(o, 'ACCEPTED')}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" loading={busy === `${o.date}|REVOKED`} disabled={closed} onClick={() => decide(o, 'REVOKED')}>
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" loading={busy === `${o.date}|PENDING`} disabled={closed} onClick={() => decide(o, 'PENDING')}>
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

interface BlockedCreditItem {
  date: string;
  blocked_at: string;
  credit_from_at: string;
  clocked_in_at: string;
  waitedMin: number;
  creditedMin: number;
  amount_cent: number;
  decision: 'ACCEPTED' | 'REVOKED' | null;
}

function creditState(d: BlockedCreditItem['decision']): { label: string; tone: string } {
  if (d === 'REVOKED') return { label: 'Not credited', tone: 'text-muted' };
  if (d === 'ACCEPTED') return { label: 'Credited — paid', tone: 'text-success' };
  return { label: 'Waiting on you — not paid', tone: 'text-warning' };
}

// The attention queue reaches back only seven days and only shows undecided
// days, which left a credit older than that withheld with no way to reach it —
// and an accepted credit that went stale after a punch correction dropping out
// of a past month's gross with nothing to prompt anyone. This is the
// month-scoped surface, mirroring the penalty and overtime modals.
function BlockedCreditModal({ row, month, closed, onClose, onChanged }: { row: Row; month: string; closed: boolean; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<BlockedCreditItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await apiGet<{ credits: BlockedCreditItem[] }>(`/api/admin/blocked-credit?userId=${row.user_id}&month=${month}`);
    if (r.ok) setItems(r.data.credits);
    else setErr(errorMessage(r));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function decide(c: BlockedCreditItem, decision: 'ACCEPTED' | 'REVOKED' | 'PENDING') {
    const id = `${c.date}|${decision}`;
    setBusy(id); setErr(null);
    const res = await apiSend('/api/admin/blocked-credit/decision', {
      idempotent: true, idemPrefix: 'bc',
      // This modal does not poll, so the figure on screen can go stale while it
      // sits open. Sending it lets the server refuse a ruling made against an
      // amount that no longer exists.
      body: { userId: row.user_id, date: c.date, decision, creditedMin: c.creditedMin },
    });
    setBusy(null);
    if (!res.ok) {
      setErr(errorMessage(res));
      await load();
      return;
    }
    setItems((prev) => prev?.map((x) => (x.date === c.date ? { ...x, decision: decision === 'PENDING' ? null : decision } : x)) ?? null);
    onChanged();
  }

  return (
    <Modal size="lg" title={`Blocked time · ${row.username}`} onClose={onClose} footer={<Button onClick={onClose}>
      {closed && (
        <div className="mb-3">
          <Alert tone="warning">
            {month} is closed — this is the record as it was paid. Nothing here can be changed.
          </Alert>
        </div>
      )}Close</Button>}>
      <p className="mb-3 text-sm text-muted">
        Time the app refused their check-in for while they were at the branch. Nothing is paid until you
        accept it, and an accepted day that later changes goes back to waiting — so a day here may need
        approving again after you correct a punch.
      </p>
      {err && <div className="mb-3"><Alert tone="danger">{err}</Alert></div>}
      {items === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState title="No blocked time" hint="Nothing was refused for this employee this month." />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((c) => {
            const state = creditState(c.decision);
            return (
              <li key={c.date} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <div className="text-sm font-medium">
                    <span className="tabular">{c.creditedMin} min</span> could not be clocked
                  </div>
                  <div className="text-xs text-muted">
                    {c.date} · turned away {formatBeirutTime(c.blocked_at)}, in {formatBeirutTime(c.clocked_in_at)} ·{' '}
                    {centsToUsd(c.amount_cent)} · <span className={state.tone}>{state.label}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {c.decision === null ? (
                    <>
                      <Button size="sm" variant="secondary" loading={busy === `${c.date}|ACCEPTED`} disabled={closed} onClick={() => decide(c, 'ACCEPTED')}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" loading={busy === `${c.date}|REVOKED`} disabled={closed} onClick={() => decide(c, 'REVOKED')}>
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" loading={busy === `${c.date}|PENDING`} disabled={closed} onClick={() => decide(c, 'PENDING')}>
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
