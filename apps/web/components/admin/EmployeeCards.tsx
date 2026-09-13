import React from 'react';
import { centsToUsd } from '@/lib/api';
import { Badge, Button } from '@/components/ui';

export interface EmployeeCardUser {
  id: string;
  username: string;
  name: string | null;
  role: string;
  hourly_rate_cent: number;
  trip_rate_cent: number;
  is_active: boolean;
  can_roam_branches: boolean;
}

/**
 * The staff list on a phone: a card per person, the table's five columns
 * folded into two lines and a row of the same buttons. `status` and
 * `roleTone` come from the page so the card and the table cannot disagree
 * about what a status looks like.
 */
export function EmployeeCards<U extends EmployeeCardUser>({
  groups,
  showGroups,
  paid,
  roleTone,
  status,
  on,
}: {
  groups: Array<[string, U[]]>;
  showGroups: boolean;
  paid: (u: U) => boolean;
  roleTone: (u: U) => 'primary' | 'warning' | 'neutral' | 'success';
  status: (u: U) => React.ReactNode;
  on: { edit: (u: U) => void; schedule: (u: U) => void; more: (u: U) => void };
}) {
  return (
    <div className="space-y-4">
      {groups.map(([group, rows]) => (
        <section key={group}>
          {showGroups && (
            <h2 className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wider text-muted">{group}</h2>
          )}
          <ul className="space-y-3">
            {rows.map((u) => (
              <li key={u.id} className="rounded-xl border border-border bg-surface p-4 shadow-card">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 flex-none place-items-center rounded-lg bg-surface-muted text-sm font-semibold text-muted">
                    {(u.name || u.username).slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-semibold">{u.name || u.username}</span>
                      {u.name && <span className="text-xs text-muted">@{u.username}</span>}
                      {!u.is_active && <Badge tone="neutral">inactive</Badge>}
                      {u.can_roam_branches && <Badge tone="warning">any branch</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <Badge tone={roleTone(u)}>{u.role.toLowerCase()}</Badge>
                      {paid(u) && (
                        <span className="tabular text-muted">
                          {centsToUsd(u.hourly_rate_cent)}/h
                          {u.role === 'DRIVER' && u.trip_rate_cent > 0 && <> + {centsToUsd(u.trip_rate_cent)}/trip</>}
                        </span>
                      )}
                      {status(u)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                  <Button size="sm" variant="secondary" className="flex-1" onClick={() => on.edit(u)}>Edit</Button>
                  {paid(u) && (
                    <Button size="sm" variant="secondary" className="flex-1" onClick={() => on.schedule(u)}>Schedule</Button>
                  )}
                  <Button size="sm" variant="ghost" aria-label="More actions" onClick={() => on.more(u)}>⋯</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
