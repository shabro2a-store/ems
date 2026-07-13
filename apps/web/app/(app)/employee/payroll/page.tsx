'use client';

import { useEffect, useState } from 'react';

interface PayoutData {
  hours: number;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  net_cent: number;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function EmployeePayrollPage() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<PayoutData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const res = await fetch(`/api/me/payroll?month=${encodeURIComponent(month)}`, { credentials: 'include' });
    const body = await res.json();
    if (!body.ok) {
      setError(body.error?.code ?? 'ERROR');
      setData(null);
      return;
    }
    setData(body.data);
  }

  useEffect(() => {
    load();
  }, [month]);

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <main className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-semibold">Payroll</h1>

      <label className="mt-4 block">
        <span className="text-sm">Month</span>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="mt-1 rounded border px-3 py-2"
        />
      </label>

      {error && <div className="mt-4 text-red-600">{error}</div>}

      {data && (
        <table className="mt-6 w-full text-left">
          <tbody>
            <tr><th className="py-2">Hours</th><td>{data.hours.toFixed(2)}</td></tr>
            <tr><th className="py-2">Gross</th><td>{usd(data.gross_cent)}</td></tr>
            <tr><th className="py-2">Adjustments</th><td>{usd(data.adjustments_cent)}</td></tr>
            <tr><th className="py-2">Approved advances</th><td>{usd(data.advances_cent)}</td></tr>
            <tr className="border-t"><th className="py-2 font-bold">Net</th><td className="font-bold">{usd(data.net_cent)}</td></tr>
          </tbody>
        </table>
      )}
    </main>
  );
}