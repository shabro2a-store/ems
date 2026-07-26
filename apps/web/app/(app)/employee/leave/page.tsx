'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend, errorMessage } from '@/lib/api';
import { Card, CardBody, CardHeader, StatTile, Field, Input, Select, Textarea, Button, Badge, Alert, EmptyState } from '@/components/ui';

interface Upcoming { date: string; kind: string; start_time?: string | null; end_time?: string | null; note: string | null }
interface Summary { pending: number; upcoming: Upcoming[] }

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function EmployeeLeavePage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [kind, setKind] = useState<'DAY_OFF' | 'TIME_CHANGE'>('DAY_OFF');
  const [start, setStart] = useState(todayStr());
  const [end, setEnd] = useState(todayStr());
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await apiGet<Summary>('/api/me/leave');
    if (r.ok) setSummary(r.data);
  }
  useEffect(() => { refresh(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setOk(null); setBusy(true);
    const body: Record<string, unknown> = { kind, start_date: start, end_date: end, note: note || undefined };
    if (kind === 'TIME_CHANGE') { body.start_time = startTime; body.end_time = endTime; }
    const r = await apiSend('/api/me/leave', { idempotent: true, idemPrefix: 'leave', body });
    setBusy(false);
    if (!r.ok) { setErr(errorMessage(r)); return; }
    setNote(''); setOk('Request sent. Your manager will review it.');
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Leave &amp; day off</h1>

      <StatTile label="Pending requests" value={summary?.pending ?? '—'} tone={summary && summary.pending > 0 ? 'warning' : 'neutral'} />

      <Card>
        <CardHeader title="Request time off" />
        <CardBody>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Type" htmlFor="k">
              <Select id="k" value={kind} onChange={(e) => setKind(e.target.value as 'DAY_OFF' | 'TIME_CHANGE')}>
                <option value="DAY_OFF">Day off</option>
                <option value="TIME_CHANGE">Change hours</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" htmlFor="sd"><Input id="sd" type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></Field>
              <Field label="To" htmlFor="ed"><Input id="ed" type="date" value={end} onChange={(e) => setEnd(e.target.value)} required /></Field>
            </div>
            {kind === 'TIME_CHANGE' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start" htmlFor="st"><Input id="st" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
                <Field label="End" htmlFor="et"><Input id="et" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></Field>
              </div>
            )}
            <Field label="Note (optional)" htmlFor="n"><Textarea id="n" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Family event" /></Field>
            {err && <Alert tone="danger">{err}</Alert>}
            {ok && <Alert tone="success">{ok}</Alert>}
            <Button type="submit" fullWidth size="lg" loading={busy}>Send request</Button>
          </form>
        </CardBody>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Upcoming</h2>
        {!summary || summary.upcoming.length === 0 ? (
          <EmptyState title="Nothing scheduled" hint="Approved days off will show here." />
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {summary.upcoming.map((u, i) => (
                <li key={i} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="font-medium tabular">{u.date}</div>
                    {u.note && <div className="text-xs text-muted">{u.note}</div>}
                  </div>
                  <Badge tone={u.kind === 'DAY_OFF' ? 'primary' : 'neutral'}>{u.kind === 'DAY_OFF' ? 'Day off' : 'Hours change'}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
