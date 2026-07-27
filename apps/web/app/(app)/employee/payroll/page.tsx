'use client';

import { useEffect, useState } from 'react';
import { apiGet, centsToUsd } from '@/lib/api';
import { Card, CardBody, CardHeader, Field, Input, Spinner, StatTile } from '@/components/ui';

interface PayoutData {
  hours: number;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  penalties_cent: number;
  net_cent: number;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function EmployeePayrollPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<PayoutData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const r = await apiGet<PayoutData>(`/api/me/payroll?month=${month}`);
      if (r.ok) setData(r.data);
      setLoading(false);
    })();
  }, [month]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">My pay</h1>
        <Field htmlFor="m"><Input id="m" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-auto" /></Field>
      </div>

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : !data ? (
        <p className="text-sm text-muted">No data for this month.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Take-home" value={centsToUsd(data.net_cent)} tone="success" />
            <StatTile label="Hours" value={data.hours.toFixed(1)} />
          </div>
          <Card>
            <CardHeader title="Breakdown" subtitle={month} />
            <CardBody>
              <dl className="divide-y divide-border text-sm">
                <Line k="Gross pay" v={centsToUsd(data.gross_cent)} />
                <Line k="Bonuses / deductions" v={`${data.adjustments_cent >= 0 ? '+' : '−'}${centsToUsd(Math.abs(data.adjustments_cent), false)}`} tone={data.adjustments_cent > 0 ? 'success' : data.adjustments_cent < 0 ? 'danger' : undefined} />
                <Line k="Late / early penalties" v={data.penalties_cent ? `−${centsToUsd(data.penalties_cent, false)}` : '—'} tone={data.penalties_cent ? 'danger' : undefined} />
                <Line k="Advances taken" v={data.advances_cent ? `−${centsToUsd(data.advances_cent, false)}` : '—'} tone={data.advances_cent ? 'danger' : undefined} />
                <div className="flex items-center justify-between py-3">
                  <dt className="font-semibold">Take-home</dt>
                  <dd className="tabular text-lg font-bold">{centsToUsd(data.net_cent)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>
          <p className="text-center text-xs text-muted">Gross uses your hourly rate for hours worked this month.</p>
        </>
      )}
    </div>
  );
}

function Line({ k, v, tone }: { k: string; v: string; tone?: 'success' | 'danger' }) {
  return (
    <div className="flex items-center justify-between py-3">
      <dt className="text-muted">{k}</dt>
      <dd className={`tabular font-medium ${tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : ''}`}>{v}</dd>
    </div>
  );
}
