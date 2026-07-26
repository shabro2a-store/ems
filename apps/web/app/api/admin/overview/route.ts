import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { todayInBeirut, todayInBeirutDateRange } from 'time';

// Powers the redesigned admin dashboard: live per-employee status, KPIs, and the
// "needs attention" queue. Supports ?branchId=<id> to scope everything to one branch
// (omit or 'all' for every branch).

type Status = 'IN' | 'ON_TRIP' | 'DAY_OFF' | 'ABSENT';

function pairMinutes(
  punches: { kind: string; at: Date }[],
  now: number,
): { minutes: number; openInAt: Date | null } {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  let total = 0;
  let openIn: Date | null = null;
  for (const p of sorted) {
    if (p.kind === 'IN') {
      if (!openIn) openIn = p.at;
    } else if (openIn) {
      total += Math.max(0, Math.floor((p.at.getTime() - openIn.getTime()) / 60_000));
      openIn = null;
    }
  }
  if (openIn) total += Math.max(0, Math.floor((now - openIn.getTime()) / 60_000));
  return { minutes: total, openInAt: openIn };
}

export async function GET(req: Request) {
  const h = headers();
  if (h.get('x-user-role') !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } }, { status: 403 });
  }

  const url = new URL(req.url);
  const branchParam = url.searchParams.get('branchId');
  const branchId = branchParam && branchParam !== 'all' ? branchParam : null;
  const inScope = (bId: string | null | undefined) => !branchId || bId === branchId;

  const todayStr = todayInBeirut();
  const { startUtc, endUtc } = todayInBeirutDateRange(todayStr);
  const dateOnly = new Date(`${todayStr}T00:00:00.000Z`);
  const now = Date.now();

  const [branches, users, todayPunches, openTrips, dayOffs, todayFlags, pendingAdv, pendingLeave] =
    await Promise.all([
      prisma.branch.findMany({
        where: { is_active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, trip_threshold_min: true },
      }),
      prisma.user.findMany({
        where: { is_active: true, role: { in: ['EMPLOYEE', 'DRIVER'] } },
        select: { id: true, username: true, role: true, branch_id: true, hourly_rate_cent: true },
      }),
      prisma.punch.findMany({
        where: { at: { gte: startUtc, lt: endUtc } },
        select: { user_id: true, kind: true, at: true },
      }),
      prisma.trip.findMany({
        where: { back_at: null },
        orderBy: { out_at: 'asc' },
        select: {
          id: true,
          driver_id: true,
          branch_id: true,
          out_at: true,
          driver: { select: { username: true } },
          branch: { select: { name: true, trip_threshold_min: true } },
        },
      }),
      prisma.scheduleOverride.findMany({
        where: { date: dateOnly, kind: 'DAY_OFF' },
        select: { user_id: true },
      }),
      prisma.flag.findMany({
        where: { created_at: { gte: startUtc, lt: endUtc }, notified_at: null },
        orderBy: { created_at: 'desc' },
        take: 30,
        include: { user: { select: { username: true, branch_id: true } }, branch: { select: { name: true } } },
      }),
      prisma.advance.findMany({
        where: { status: 'PENDING' },
        orderBy: { created_at: 'asc' },
        include: { user: { select: { username: true, branch_id: true } } },
      }),
      prisma.leaveRequest.findMany({
        where: { status: 'PENDING' },
        orderBy: { created_at: 'asc' },
        include: { user: { select: { username: true, branch_id: true } } },
      }),
    ]);

  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const punchesByUser = new Map<string, { kind: string; at: Date }[]>();
  for (const p of todayPunches) {
    const list = punchesByUser.get(p.user_id) ?? [];
    list.push({ kind: p.kind, at: p.at });
    punchesByUser.set(p.user_id, list);
  }
  const openTripByDriver = new Map(openTrips.map((t) => [t.driver_id, t]));
  const dayOffSet = new Set(dayOffs.map((d) => d.user_id));

  let present = 0;
  let absent = 0;
  let hoursMinutes = 0;
  let laborCent = 0;

  const people = users
    .filter((u) => inScope(u.branch_id))
    .map((u) => {
      const trip = u.role === 'DRIVER' ? openTripByDriver.get(u.id) : undefined;
      const { minutes, openInAt } = pairMinutes(punchesByUser.get(u.id) ?? [], now);
      hoursMinutes += minutes;
      laborCent += Math.floor((minutes * u.hourly_rate_cent) / 60);

      let status: Status;
      let sinceMin = 0;
      let over = false;
      if (trip) {
        status = 'ON_TRIP';
        sinceMin = Math.max(0, Math.floor((now - trip.out_at.getTime()) / 60_000));
        over = sinceMin > trip.branch.trip_threshold_min;
      } else if (openInAt) {
        status = 'IN';
        sinceMin = Math.max(0, Math.floor((now - openInAt.getTime()) / 60_000));
        present += 1;
      } else if (dayOffSet.has(u.id)) {
        status = 'DAY_OFF';
      } else {
        status = 'ABSENT';
        absent += 1;
      }

      return {
        id: u.id,
        username: u.username,
        role: u.role,
        branch_id: u.branch_id,
        branch_name: u.branch_id ? branchName.get(u.branch_id) ?? null : null,
        status,
        since_min: sinceMin,
        over,
        hours_today: Math.round((minutes / 60) * 10) / 10,
      };
    });

  const driversOutList = openTrips
    .filter((t) => inScope(t.branch_id))
    .map((t) => ({
      trip_id: t.id,
      driver_id: t.driver_id,
      driver_username: t.driver.username,
      branch_id: t.branch_id,
      branch_name: t.branch.name,
      since_min: Math.max(0, Math.floor((now - t.out_at.getTime()) / 60_000)),
      threshold_min: t.branch.trip_threshold_min,
    }));
  const driversOver = driversOutList.filter((d) => d.since_min > d.threshold_min);

  const flags = todayFlags
    .filter((f) => inScope(f.branch_id ?? f.user?.branch_id))
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      username: f.user?.username ?? null,
      branch_name: f.branch?.name ?? (f.user?.branch_id ? branchName.get(f.user.branch_id) ?? null : null),
      created_at: f.created_at.toISOString(),
      notified_at: f.notified_at ? f.notified_at.toISOString() : null,
    }));

  const pendingAdvances = pendingAdv
    .filter((a) => inScope(a.user?.branch_id))
    .map((a) => ({ id: a.id, username: a.user?.username ?? '—', amount_cent: a.amount_cent, reason: a.reason }));

  const pendingLeaves = pendingLeave
    .filter((l) => inScope(l.user?.branch_id))
    .map((l) => ({
      id: l.id,
      username: l.user?.username ?? '—',
      kind: l.kind,
      start_date: l.start_date.toISOString().slice(0, 10),
      end_date: l.end_date.toISOString().slice(0, 10),
      note: l.note,
    }));

  return NextResponse.json({
    ok: true,
    data: {
      branches: branches.map((b) => ({ id: b.id, name: b.name })),
      branchId: branchId ?? 'all',
      kpis: {
        present,
        absent,
        driversOut: driversOutList.length,
        driversOver: driversOver.length,
        hoursToday: Math.round((hoursMinutes / 60) * 10) / 10,
        laborTodayCent: laborCent,
      },
      people,
      attention: {
        lateDrivers: driversOver.map((d) => ({
          trip_id: d.trip_id,
          driver_username: d.driver_username,
          branch_name: d.branch_name,
          since_min: d.since_min,
          threshold_min: d.threshold_min,
        })),
        flags,
        pendingAdvances,
        pendingLeaves,
      },
    },
  });
}

export const dynamic = 'force-dynamic';
