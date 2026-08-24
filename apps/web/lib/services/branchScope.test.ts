import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }));

import { punchableBranches, openCheckInBranchId, type GeoBranch } from './branchScope';

const branch = (id: string, is_active = true): GeoBranch => ({
  id,
  lat: 33.9,
  lng: 35.5,
  gps_radius_m: 50,
  gps_accuracy_max_m: 100,
  is_active,
});

type PunchRow = { user_id: string; kind: 'IN' | 'OUT'; at: Date; branch_id: string };

function fakeDb(opts: { branches?: GeoBranch[]; punches?: PunchRow[] } = {}) {
  const branches = opts.branches ?? [];
  const punches = opts.punches ?? [];
  return {
    branch: {
      findMany: async ({ where }: { where: { is_active: boolean } }) =>
        branches.filter((b) => b.is_active === where.is_active),
      findUnique: async ({ where }: { where: { id: string } }) =>
        branches.find((b) => b.id === where.id) ?? null,
    },
    punch: {
      findFirst: async ({
        where,
      }: {
        where: { user_id: string; kind: 'IN' | 'OUT'; at?: { gt: Date } };
      }) => {
        const rows = punches
          .filter((p) => p.user_id === where.user_id && p.kind === where.kind)
          .filter((p) => (where.at?.gt ? p.at > where.at.gt : true))
          .sort((a, b) => b.at.getTime() - a.at.getTime());
        return rows[0] ?? null;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const HOME = branch('home');
const OTHER = branch('other');
const CLOSED = branch('closed', false);

describe('punchableBranches', () => {
  it('restricts a normal employee to their own branch, both directions', async () => {
    const db = fakeDb({ branches: [HOME, OTHER] });
    const user = { id: 'u1', can_roam_branches: false, branch: HOME };
    expect((await punchableBranches(db, user, 'IN')).map((b) => b.id)).toEqual(['home']);
    expect((await punchableBranches(db, user, 'OUT')).map((b) => b.id)).toEqual(['home']);
  });

  it('opens every active branch to a roamer, and only active ones', async () => {
    const db = fakeDb({ branches: [HOME, OTHER, CLOSED] });
    const ids = (await punchableBranches(db, { id: 'u1', can_roam_branches: true, branch: HOME }, 'IN'))
      .map((b) => b.id)
      .sort();
    expect(ids).toEqual(['home', 'other']);
  });

  it('lets a shift be closed where it was opened after the privilege is revoked', async () => {
    // The trap this exists for: the owner restricts somebody who is standing at
    // the other branch mid-cover. Every clock-out there would be refused
    // OUT_OF_GEOFENCE until they drove back or the 30h sweep closed it.
    const db = fakeDb({
      branches: [HOME, OTHER],
      punches: [{ user_id: 'u1', kind: 'IN', at: new Date('2026-08-24T06:00:00Z'), branch_id: 'other' }],
    });
    const user = { id: 'u1', can_roam_branches: false, branch: HOME };

    expect((await punchableBranches(db, user, 'OUT')).map((b) => b.id).sort()).toEqual(['home', 'other']);
    // The check-in itself is still refused there — this widens nothing.
    expect((await punchableBranches(db, user, 'IN')).map((b) => b.id)).toEqual(['home']);
  });

  it('closes a shift opened at a branch that has since been deactivated', async () => {
    const db = fakeDb({
      branches: [HOME, CLOSED],
      punches: [{ user_id: 'u1', kind: 'IN', at: new Date('2026-08-24T06:00:00Z'), branch_id: 'closed' }],
    });
    const out = await punchableBranches(db, { id: 'u1', can_roam_branches: false, branch: HOME }, 'OUT');
    // verifyWithinGeofence drops inactive branches, so it is forced active here:
    // a branch shut mid-shift must not take the clock-out down with it.
    expect(out.find((b) => b.id === 'closed')?.is_active).toBe(true);
  });

  it('adds nothing extra once the session is closed', async () => {
    const db = fakeDb({
      branches: [HOME, OTHER],
      punches: [
        { user_id: 'u1', kind: 'IN', at: new Date('2026-08-24T06:00:00Z'), branch_id: 'other' },
        { user_id: 'u1', kind: 'OUT', at: new Date('2026-08-24T14:00:00Z'), branch_id: 'other' },
      ],
    });
    const out = await punchableBranches(db, { id: 'u1', can_roam_branches: false, branch: HOME }, 'OUT');
    expect(out.map((b) => b.id)).toEqual(['home']);
  });
});

describe('openCheckInBranchId', () => {
  it('is null with no punches at all', async () => {
    expect(await openCheckInBranchId(fakeDb(), 'u1')).toBeNull();
  });

  it('reports where the open session was started', async () => {
    const db = fakeDb({
      punches: [{ user_id: 'u1', kind: 'IN', at: new Date('2026-08-24T06:00:00Z'), branch_id: 'other' }],
    });
    expect(await openCheckInBranchId(db, 'u1')).toBe('other');
  });

  it('is null once the session is closed', async () => {
    const db = fakeDb({
      punches: [
        { user_id: 'u1', kind: 'IN', at: new Date('2026-08-24T06:00:00Z'), branch_id: 'other' },
        { user_id: 'u1', kind: 'OUT', at: new Date('2026-08-24T14:00:00Z'), branch_id: 'home' },
      ],
    });
    expect(await openCheckInBranchId(db, 'u1')).toBeNull();
  });
});
