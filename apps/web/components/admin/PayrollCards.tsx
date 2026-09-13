import React from 'react';
import { centsToUsd } from '@/lib/api';
import { Button } from '@/components/ui';

/** The payroll row as the page and the API shape it. */
export interface PayrollCardRow {
  user_id: string;
  username: string;
  role: string;
  rate_cent: number;
  expected_salary_cent: number | null;
  hours: number;
  gross_cent: number;
  blocked_credit_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
  overtime_deduction_cent: number;
  trips_count: number;
  trips_cent: number;
  net_cent: number;
}

export interface PayrollCardActions<R> {
  rate: (r: R) => void;
  blockedCredit: (r: R) => void;
  trips: (r: R) => void;
  adjustments: (r: R) => void;
  penalties: (r: R) => void;
  overtime: (r: R) => void;
  salary: (r: R) => void;
  adjust: (r: R) => void;
}

const signed = (cent: number) => `${cent > 0 ? '+' : '−'}${centsToUsd(Math.abs(cent), false)}`;

/**
 * One figure of the row, tappable when there is a dialog behind it. The same
 * dashed underline the table uses, so a figure that opens something looks the
 * same on a phone as on a laptop.
 */
function Figure({
  label,
  value,
  tone,
  onClick,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'success' | 'danger' | 'muted';
  onClick?: () => void;
  title?: string;
}) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-muted' : 'text-content';
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          title={title}
          className={`tabular mt-0.5 border-b border-dashed border-border text-sm font-medium ${color}`}
        >
          {value}
        </button>
      ) : (
        <div className={`tabular mt-0.5 text-sm font-medium ${color}`}>{value}</div>
      )}
    </div>
  );
}

/**
 * Payroll on a phone: one card per person instead of twelve columns.
 *
 * Net first, because that is the number the owner is checking; the hours and
 * the rate on the line under the name, because together they explain most of
 * it; then every other figure in a grid, each one opening the same dialog its
 * table cell does. The table stays for md and up - a laptop reads a table.
 */
export function PayrollCards<R extends PayrollCardRow>({
  groups,
  showGroups,
  closed,
  month,
  on,
}: {
  groups: Array<[string, R[]]>;
  showGroups: boolean;
  closed: boolean;
  month: string;
  on: PayrollCardActions<R>;
}) {
  return (
    <div className="space-y-4">
      {groups.map(([group, rows]) => (
        <section key={group}>
          {showGroups && (
            <h2 className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wider text-muted">{group}</h2>
          )}
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.user_id} className="rounded-xl border border-border bg-surface p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{r.username}</div>
                    <div className="text-xs text-muted">
                      {r.role.toLowerCase()} · <span className="tabular">{r.hours.toFixed(1)}h</span> ·{' '}
                      <button
                        type="button"
                        onClick={() => on.rate(r)}
                        className="tabular border-b border-dashed border-primary/50 text-content"
                        title="Change hourly rate"
                      >
                        {centsToUsd(r.rate_cent)}/h
                      </button>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Net</div>
                    <div className="tabular text-lg font-semibold leading-tight">{centsToUsd(r.net_cent)}</div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5">
                  <Figure
                    label="Gross"
                    value={centsToUsd(r.gross_cent)}
                    onClick={() => on.blockedCredit(r)}
                    title="Includes any blocked time you accepted. Tap to review blocked time."
                  />
                  {r.role === 'DRIVER' ? (
                    <Figure
                      label="Trips"
                      value={r.trips_count === 0 ? '—' : `${r.trips_count} · ${centsToUsd(r.trips_cent, false)}`}
                      tone={r.trips_count === 0 ? 'muted' : undefined}
                      onClick={() => on.trips(r)}
                    />
                  ) : (
                    <Figure label="Trips" value="—" tone="muted" />
                  )}
                  <Figure
                    label="Adjust."
                    value={r.adjustments_cent === 0 ? '—' : signed(r.adjustments_cent)}
                    tone={r.adjustments_cent > 0 ? 'success' : r.adjustments_cent < 0 ? 'danger' : 'muted'}
                    onClick={() => on.adjustments(r)}
                  />
                  <Figure
                    label="Penalty"
                    value={r.penalties_cent === 0 ? '—' : `−${centsToUsd(r.penalties_cent, false)}`}
                    tone={r.penalties_cent > 0 ? 'danger' : 'muted'}
                    onClick={() => on.penalties(r)}
                  />
                  <Figure
                    label="OT revoked"
                    value={r.overtime_deduction_cent === 0 ? '—' : `−${centsToUsd(r.overtime_deduction_cent, false)}`}
                    tone={r.overtime_deduction_cent > 0 ? 'danger' : 'muted'}
                    onClick={() => on.overtime(r)}
                  />
                  <Figure
                    label="Advances"
                    value={r.advances_cent === 0 ? '—' : `−${centsToUsd(r.advances_cent, false)}`}
                    tone={r.advances_cent > 0 ? 'danger' : 'muted'}
                  />
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                  <Figure
                    label="Expected"
                    value={r.expected_salary_cent == null ? '—' : centsToUsd(r.expected_salary_cent)}
                    tone={r.expected_salary_cent == null ? 'muted' : undefined}
                    onClick={() => on.salary(r)}
                    title="Expected monthly salary, for reference only"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={closed}
                    title={closed ? `${month} is closed — adjust the current month instead.` : undefined}
                    onClick={() => on.adjust(r)}
                  >
                    ＋ Adjust
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
