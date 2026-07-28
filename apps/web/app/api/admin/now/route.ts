import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';

interface PresentUser {
  id: string;
  username: string;
  in_at: string;
  minutes_since_in: number;
  branch_id: string;
}

interface DriverOut {
  trip_id: string;
  driver_id: string;
  driver_username: string;
  branch_id: string;
  out_at: string;
  since_min: number;
  threshold_min: number;
}

interface FlagOut {
  id: string;
  kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD';
  user_id: string | null;
  username: string | null;
  branch_id: string | null;
  branch_name: string | null;
  context_json: unknown;
  created_at: string;
  notified_at: string | null;
}

function startOfTodayBeirut(): Date {
  const offsetMs = 3 * 60 * 60_000;
  const nowBeirut = new Date(Date.now() + offsetMs);
  const startOfDay = new Date(Date.UTC(nowBeirut.getUTCFullYear(), nowBeirut.getUTCMonth(), nowBeirut.getUTCDate(), 0, 0, 0, 0));
  return new Date(startOfDay.getTime() - offsetMs);
}

export async function GET() {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') {
    return NextResponse.json(
      { ok: false, error: { code: 'FORBIDDEN', message: 'Admin only' } },
      { status: 403 },
    );
  }

  const [branchesRaw, openTrips, todayFlags] = await Promise.all([
    prisma.branch.findMany({
      where: { is_active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        trip_threshold_min: true,
        users: {
          where: { is_active: true },
          select: {
            id: true,
            username: true,
            role: true,
            punches: {
              orderBy: { at: 'desc' },
              take: 1,
              select: { kind: true, at: true },
            },
          },
        },
      },
    }),
    prisma.trip.findMany({
      where: { back_at: null },
      select: {
        id: true,
        driver_id: true,
        branch_id: true,
        out_at: true,
        driver: { select: { username: true, role: true } },
        branch: { select: { name: true, trip_threshold_min: true } },
      },
      orderBy: { out_at: 'asc' },
    }),
    prisma.flag.findMany({
      where: {
        created_at: { gte: startOfTodayBeirut() },
      },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: {
        user: { select: { username: true } },
        branch: { select: { name: true } },
      },
    }),
  ]);

  const now = Date.now();
  const branchDriverMap = new Map<string, DriverOut[]>();

  for (const t of openTrips) {
    if (t.driver.role !== 'DRIVER') continue;
    const driverOut: DriverOut = {
      trip_id: t.id,
      driver_id: t.driver_id,
      driver_username: t.driver.username,
      branch_id: t.branch_id,
      out_at: t.out_at.toISOString(),
      since_min: Math.max(0, Math.floor((now - t.out_at.getTime()) / 60_000)),
      threshold_min: t.branch.trip_threshold_min,
    };
    const list = branchDriverMap.get(t.branch_id) ?? [];
    list.push(driverOut);
    branchDriverMap.set(t.branch_id, list);
  }

  const branches = branchesRaw.map((b) => {
    const present: PresentUser[] = [];
    const absent: { id: string; username: string; role: 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER' }[] = [];
    for (const u of b.users) {
      const last = u.punches[0];
      if (last && last.kind === 'IN') {
        const minutes_since_in = Math.max(0, Math.floor((now - last.at.getTime()) / 60_000));
        present.push({
          id: u.id,
          username: u.username,
          in_at: last.at.toISOString(),
          minutes_since_in,
          branch_id: b.id,
        });
      } else {
        absent.push({ id: u.id, username: u.username, role: u.role });
      }
    }
    return {
      id: b.id,
      name: b.name,
      present,
      absent,
      driversOut: branchDriverMap.get(b.id) ?? [],
    };
  });

  const flags: FlagOut[] = todayFlags.map((f) => ({
    id: f.id,
    kind: f.kind,
    user_id: f.user_id,
    username: f.user?.username ?? null,
    branch_id: f.branch_id,
    branch_name: f.branch?.name ?? null,
    context_json: f.context_json,
    created_at: f.created_at.toISOString(),
    notified_at: f.notified_at ? f.notified_at.toISOString() : null,
  }));

  return NextResponse.json({ ok: true, data: { branches, flags } });
}

export const dynamic = 'force-dynamic';