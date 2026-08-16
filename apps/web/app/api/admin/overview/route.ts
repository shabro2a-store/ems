import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { todayInBeirut, todayInBeirutDateRange, beirutWeekday } from 'time';
import { pendingPenaltyNotices } from '@/lib/services/penalty';
import { pendingOvertimeNotices } from '@/lib/services/overtime';
import { requiredMinFor } from '@/lib/services/coverage';
import { lookbackMonths, mergeNotices } from '@/lib/services/noticeWindow';

// How far back the penalty review queue looks. Older ones are a payroll matter.
const PENALTY_LOOKBACK_DAYS = 7;

// A flag row that only names its kind ("watched") tells the admin nothing about
// why the system raised it. The detail is already in context_json — this turns it
// into the sentence the admin actually needs.
function flagReason(kind: string, ctx: unknown): string {
  const c = (ctx ?? {}) as { shift_min?: number; over_min?: number };
  const mins = typeof c.over_min === 'number' ? c.over_min : null;
  const late = mins === null ? '' : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  switch (kind) {
    case 'WATCHED':
      return c.shift_min
        ? `No punch at all - they were scheduled ${Math.round(c.shift_min / 60)}h.`
        : 'No punch at all on a scheduled day.';
    case 'MISSED_CHECKOUT':
      return c.shift_min
        ? `Still clocked in past their ${Math.round(c.shift_min / 60)}h shift${late ? `, ${late} over` : ''}. Overtime, or forgot to punch out?`
        : 'Still clocked in well past the end of their shift.';
    case 'TRIP_OVER_THRESHOLD':
      return 'Out on an order longer than the branch threshold.';
    default:
      return 'Needs a look.';
  }
}

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
  const todayWeekday = beirutWeekday(new Date());
  const now = Date.now();

  const [
    branches,
    users,
    todayPunches,
    openTrips,
    todayOverrides,
    todaySchedules,
    todayFlags,
    pendingAdv,
    pendingLeave,
    tripsTodayAgg,
  ] = await Promise.all([
      prisma.branch.findMany({
        where: { is_active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, trip_threshold_min: true },
      }),
      prisma.user.findMany({
        where: { is_active: true, role: { in: ['EMPLOYEE', 'DRIVER'] } },
        select: { id: true, username: true, name: true, role: true, branch_id: true, hourly_rate_cent: true },
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
      // Every override for today, plus today's weekly hours: whether someone is
      // off is the same question payroll answers, and it is not answered by the
      // override's kind alone - a full shift of approved time off is an
      // HOURS_CHANGE resolving to zero, and a weekday nobody is scheduled for
      // owes nothing either. Both used to render as ABSENT.
      prisma.scheduleOverride.findMany({
        where: { date: dateOnly },
        select: { user_id: true, kind: true, shift_min: true },
      }),
      prisma.schedule.findMany({
        where: { weekday: todayWeekday },
        select: { user_id: true, shift_min: true },
      }),
      prisma.flag.findMany({
        where: { created_at: { gte: startUtc, lt: endUtc }, resolved_at: null },
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
      prisma.trip.groupBy({
        by: ['driver_id'],
        where: { out_at: { gte: startUtc, lt: endUtc } },
        _count: { _all: true },
      }),
    ]);

  const tripsTodayByDriver = new Map(tripsTodayAgg.map((t) => [t.driver_id, t._count._all]));

  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const punchesByUser = new Map<string, { kind: string; at: Date }[]>();
  for (const p of todayPunches) {
    const list = punchesByUser.get(p.user_id) ?? [];
    list.push({ kind: p.kind, at: p.at });
    punchesByUser.set(p.user_id, list);
  }
  const openTripByDriver = new Map(openTrips.map((t) => [t.driver_id, t]));
  const overrideByUser = new Map(todayOverrides.map((o) => [o.user_id, o]));
  const shiftMinByUser = new Map(todaySchedules.map((s) => [s.user_id, s.shift_min]));
  const requiredMinToday = (userId: string): number =>
    requiredMinFor(overrideByUser.get(userId), shiftMinByUser.get(userId));

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
      } else if (requiredMinToday(u.id) === 0) {
        status = 'DAY_OFF';
      } else {
        status = 'ABSENT';
        absent += 1;
      }

      return {
        id: u.id,
        username: u.name || u.username,
        role: u.role,
        branch_id: u.branch_id,
        branch_name: u.branch_id ? branchName.get(u.branch_id) ?? null : null,
        status,
        since_min: sinceMin,
        over,
        hours_today: Math.round((minutes / 60) * 10) / 10,
        trips_today: u.role === 'DRIVER' ? tripsTodayByDriver.get(u.id) ?? 0 : null,
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
      reason: flagReason(f.kind, f.context_json),
    }));

  // Shortfall penalties and overtime pay both apply automatically, so this queue
  // is a review list: the admin either lets one stand (acknowledge/accept) or
  // reverses it — waiving a penalty someone gave notice for, or revoking
  // overtime that wasn't warranted. Scoped to the recent past — an old one is a
  // payroll matter, not something needing attention today.
  const penaltyUsers = users.filter((u) => inScope(u.branch_id)).map((u) => ({ id: u.id, username: u.name || u.username }));
  const since = new Date(startUtc.getTime() - PENALTY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  // Both loaders window their punch queries by a single month, so the lookback
  // has to be asked for month by month or it stops at the 1st.
  const months = lookbackMonths(since, todayStr);

  const [penaltyBatches, overtimeBatches] = await Promise.all([
    Promise.all(months.map((m) => pendingPenaltyNotices(penaltyUsers, m, prisma, { since }))),
    Promise.all(months.map((m) => pendingOvertimeNotices(penaltyUsers, m, prisma, { since }))),
  ]);

  const penalties = mergeNotices(penaltyBatches).map((p) => ({
    user_id: p.user_id,
    username: p.username,
    date: p.date,
    kind: p.kind,
    minutes: p.minutes,
    hours: p.hours,
    amount_cent: p.amount_cent,
  }));

  const overtime = mergeNotices(overtimeBatches).map((o) => ({
    user_id: o.user_id,
    username: o.username,
    date: o.date,
    overtimeMin: o.overtimeMin,
    amount_cent: o.amount_cent,
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
      // An HOURS_CHANGE request is unreviewable without the hours being asked for.
      off_min: l.off_min,
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
        tripsToday: people.reduce((s, p) => s + (p.trips_today ?? 0), 0),
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
        penalties,
        overtime,
        pendingAdvances,
        pendingLeaves,
      },
    },
  });
}

export const dynamic = 'force-dynamic';
