import React from 'react';
import { formatBeirut } from '@/lib/api';
import { Badge, Button } from '@/components/ui';

export interface PunchCardRow {
  id: string;
  kind: 'IN' | 'OUT';
  at: string;
  lat: number;
  lng: number;
  accuracy_m: number;
  corrected: boolean;
  system_generated: boolean;
  user: { username: string };
  branch: { name: string };
}

/**
 * The punch log on a phone: who, which way, when - then where, in smaller
 * type - and the same Correct / Revoke buttons the table row has.
 */
export function PunchCards<P extends PunchCardRow>({
  punches,
  on,
}: {
  punches: P[];
  on: { correct: (p: P) => void; revoke: (p: P) => void };
}) {
  return (
    <ul className="space-y-2.5">
      {punches.map((p) => (
        <li key={p.id} className="rounded-xl border border-border bg-surface p-3.5 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone={p.kind === 'IN' ? 'success' : 'neutral'}>{p.kind}</Badge>
              <span className="truncate font-semibold">{p.user.username}</span>
            </div>
            <span className="tabular flex-none text-sm">{formatBeirut(p.at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>{p.branch.name}</span>
            <span aria-hidden>·</span>
            <span className="tabular">
              {p.system_generated ? 'no GPS · system punch' : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ±${p.accuracy_m}m`}
            </span>
            {p.corrected && <Badge tone="warning">corrected</Badge>}
            {p.system_generated && <Badge tone="warning">auto</Badge>}
          </div>
          <div className="mt-2.5 flex gap-2">
            {p.system_generated && p.kind === 'OUT' && (
              <Button size="sm" variant="secondary" className="flex-1" onClick={() => on.revoke(p)}>Revoke</Button>
            )}
            <Button size="sm" variant="secondary" className="flex-1" onClick={() => on.correct(p)}>Correct</Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
