'use client';

import { useEffect, useState } from 'react';

interface PayrollRow {
  user_id: string;
  username: string;
  hours: number;
  gross_cent: number;
  adjustments_cent: number;
  advances_cent: number;
  net_cent: number;
}

interface PayrollTotals {
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

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function AdminPayrollPage() {
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [totals, setTotals] = useState<PayrollTotals | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  async function load() {
    setErr(null);
    const res = await fetch(`/api/admin/payroll?month=${encodeURIComponent(month)}`, { credentials: 'include' });
    const body = await res.json();
    if (!body.ok) {
      setErr(body.error?.code ?? 'ERROR');
      setRows([]);
      setTotals(null);
      return;
    }
    setRows(body.data.rows);
    setTotals(body.data.totals);
  }

  useEffect(() => {
    load();
  }, [month]);

  async function downloadPdf() {
    setPdfBusy(true);
    try {
      const res = await fetch(
        `/api/admin/reports/payroll?month=${encodeURIComponent(month)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.text();
        setErr(`PDF failed: ${res.status} ${body.slice(0, 200)}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${month}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <main className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Payroll</h1>
        <button
          onClick={downloadPdf}
          disabled={pdfBusy}
          className="rounded bg-emerald-600 text-white px-3 py-2 text-sm disabled:opacity-50"
        >
          {pdfBusy ? 'Generating…' : '📄 Download PDF'}
        </button>
      </div>

      <label className="mt-4 block">
        <span className="text-sm">Month</span>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="mt-1 rounded border px-3 py-2"
        />
      </label>

      {err && <div className="mt-4 text-red-600">{err}</div>}

      {rows.length > 0 && (
        <table className="mt-6 w-full text-left text-sm">
          <thead className="border-b">
            <tr>
              <th className="py-2">User</th>
              <th>Hours</th>
              <th>Gross</th>
              <th>Adj</th>
              <th>Adv</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id} className="border-b">
                <td className="py-2">{r.username}</td>
                <td>{r.hours.toFixed(2)}</td>
                <td>{usd(r.gross_cent)}</td>
                <td>{usd(r.adjustments_cent)}</td>
                <td>{usd(r.advances_cent)}</td>
                <td>{usd(r.net_cent)}</td>
              </tr>
            ))}
            {totals && (
              <tr className="font-bold bg-gray-50">
                <td className="py-2">TOTAL</td>
                <td>{totals.hours.toFixed(2)}</td>
                <td>{usd(totals.gross_cent)}</td>
                <td>{usd(totals.adjustments_cent)}</td>
                <td>{usd(totals.advances_cent)}</td>
                <td>{usd(totals.net_cent)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}