import { describe, it, expect } from 'vitest';
import type { PayrollRow } from 'pdf/payroll';

/*
 * A payslip has to add up on its own.
 *
 * Every deduction inside net_cent needs a column, or the sheet the owner hands
 * somebody shows a net that cannot be derived from the figures printed next to
 * it - and the only way to find the difference is to open the app. Revoked
 * overtime was missing, so any month where the owner refused an overtime claim
 * printed a row that silently did not reconcile.
 */
const row = (over: Partial<PayrollRow> = {}): PayrollRow => ({
  username: 'bilal.f',
  role: 'EMPLOYEE',
  branch_name: 'Mar lias',
  hours: 100,
  rate_cent: 226,
  gross_cent: 22600,
  adjustments_cent: 0,
  penalties_cent: 0,
  overtime_deduction_cent: 0,
  advances_cent: 0,
  net_cent: 22600,
  ...over,
});

/** What the printed columns say the net should be. */
const fromColumns = (r: PayrollRow) =>
  r.gross_cent +
  r.adjustments_cent -
  r.penalties_cent -
  (r.overtime_deduction_cent ?? 0) -
  r.advances_cent;

describe('a printed payslip row', () => {
  it('reconciles when nothing was deducted', () => {
    const r = row();
    expect(fromColumns(r)).toBe(r.net_cent);
  });

  it('reconciles when overtime was revoked - the case that used to fail', () => {
    // $30 of overtime refused. Before the column existed the row printed gross
    // 226.00, no deductions, and a net of 196.00.
    const r = row({ overtime_deduction_cent: 3000, net_cent: 22600 - 3000 });
    expect(fromColumns(r)).toBe(r.net_cent);
  });

  it('reconciles with every deduction at once', () => {
    const r = row({
      adjustments_cent: 500,
      penalties_cent: 384,
      overtime_deduction_cent: 3000,
      advances_cent: 5000,
      net_cent: 22600 + 500 - 384 - 3000 - 5000,
    });
    expect(fromColumns(r)).toBe(r.net_cent);
    expect(r.net_cent).toBe(14716);
  });

  it('treats a row from before the column as zero, not as a hole', () => {
    // Optional so an older caller still renders; the arithmetic has to hold for
    // it too rather than producing NaN.
    const { overtime_deduction_cent: _omitted, ...older } = row();
    expect(fromColumns(older as PayrollRow)).toBe(22600);
  });
});
