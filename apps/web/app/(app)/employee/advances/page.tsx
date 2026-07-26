'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend, centsToUsd, errorMessage } from '@/lib/api';
import { Card, CardBody, CardHeader, StatTile, Field, Input, Textarea, Button, Badge, Alert, EmptyState } from '@/components/ui';

interface Summary { pending: number; approved_balance_cent: number }
interface Advance { id: string; amount_cent: number; reason: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED'; created_at: string }

const STATUS_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger' } as const;

export default function EmployeeAdvancesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [list, setList] = useState<Advance[]>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [s, l] = await Promise.all([
      apiGet<Summary>('/api/me/advances'),
      apiGet<{ advances: Advance[] }>('/api/me/advances?view=list'),
    ]);
    if (s.ok) setSummary(s.data);
    if (l.ok) setList(l.data.advances);
  }
  useEffect(() => { refresh(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setOk(null);
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setErr('Enter a positive amount.'); return; }
    setBusy(true);
    const r = await apiSend<{ id: string }>('/api/me/advances', { idempotent: true, idemPrefix: 'adv', body: { amountCent: cents, reason: reason || undefined } });
    setBusy(false);
    if (!r.ok) { setErr(errorMessage(r)); return; }
    setAmount(''); setReason(''); setOk('Request sent. Your manager will review it.');
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Advances</h1>

      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Pending" value={summary?.pending ?? '—'} tone={summary && summary.pending > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Approved balance" value={summary ? centsToUsd(summary.approved_balance_cent) : '—'} />
      </div>

      <Card>
        <CardHeader title="Request an advance" />
        <CardBody>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Amount (USD)" htmlFor="amt"><Input id="amt" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
            <Field label="Reason (optional)" htmlFor="rsn"><Textarea id="rsn" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rent" /></Field>
            {err && <Alert tone="danger">{err}</Alert>}
            {ok && <Alert tone="success">{ok}</Alert>}
            <Button type="submit" fullWidth size="lg" loading={busy}>Request advance</Button>
          </form>
        </CardBody>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Your requests</h2>
        {list.length === 0 ? (
          <EmptyState title="No requests yet" />
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {list.map((a) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="font-medium tabular">{centsToUsd(a.amount_cent)}</div>
                    {a.reason && <div className="text-xs text-muted">{a.reason}</div>}
                  </div>
                  <Badge tone={STATUS_TONE[a.status]}>{a.status.toLowerCase()}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
