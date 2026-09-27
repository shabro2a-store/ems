import { describe, it, expect } from 'vitest';
import { summaryCards, type PayrollRow } from '../../../../packages/pdf/src/payroll';

/*
 * Money #28: the PDF's summary cards - gross, adjustments, penalties,
 * advances - did not add up to "Total to pay", because revoked overtime comes
 * out of net and had no card. Anyone checking the sheet by hand came out wrong.
 */
const row = (over: Partial<PayrollRow>): PayrollRow => ({
  username: 'x',
  role: 'EMPLOYEE',
  branch_name: null,
  hours: 100,
  rate_cent: 400,
  gross_cent: 40_000,
  adjustments_cent: 0,
  penalties_cent: 0,
  advances_cent: 0,
  net_cent: 40_000,
  ...over,
});

describe('the summary cards', () => {
  it('add up to the total to pay, revoked overtime included', () => {
    const rows = [
      row({ gross_cent: 40_000, adjustments_cent: 1_500, penalties_cent: 800, overtime_deduction_cent: 1_200, advances_cent: 5_000, net_cent: 34_500 }),
      row({ gross_cent: 20_000, adjustments_cent: -300, overtime_deduction_cent: 700, net_cent: 19_000 }),
    ];
    const { total, parts } = summaryCards(rows);
    expect(total).toBe(34_500 + 19_000);
    expect(parts.reduce((sum, p) => sum + p.sign * p.cent, 0)).toBe(total);
    expect(parts.map((p) => p.label)).toContain('Overtime revoked');
  });
});
