import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { PayrollDocument, type PayrollRow } from 'pdf/payroll';

/*
 * Every other payroll test checks numbers; nothing rendered the document the
 * owner downloads. A layout change that makes react-pdf throw (a bad style
 * value, a Text inside a Text it cannot lay out) would pass them all and fail
 * only when he pressed Download.
 */
const row = (over: Partial<PayrollRow> = {}): PayrollRow => ({
  username: 'Sami & Sons <cashier>',
  role: 'EMPLOYEE',
  branch_name: 'Hamra',
  hours: 172.5,
  rate_cent: 250,
  gross_cent: 43_125,
  blocked_credit_cent: 500,
  adjustments_cent: 2_000,
  penalties_cent: 1_500,
  overtime_deduction_cent: 750,
  advances_cent: 10_000,
  net_cent: 32_875,
  ...over,
});

async function render(rows: PayrollRow[]) {
  const doc = React.createElement(PayrollDocument, { month: '2026-09', generatedAt: new Date('2026-10-01T08:00:00Z'), rows, branchName: 'Hamra' });
  return renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
}

describe('the payroll PDF', () => {
  it('renders a real PDF for a month with employees and a driver', async () => {
    const buf = await render([
      row(),
      row({ username: 'driver1', role: 'DRIVER', trips_count: 41, trips_cent: 8_200, gross_cent: 51_325, net_cent: 41_075 }),
      // Overtime at the overtime rate: the extra is inside gross, and the rate
      // is printed beside the hourly one.
      row({ username: 'overtimer', overtime_rate_cent: 375, overtime_premium_cent: 1_250, gross_cent: 44_375, net_cent: 34_125 }),
    ]);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1_000);
  });

  it('renders an empty month', async () => {
    const buf = await render([]);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
