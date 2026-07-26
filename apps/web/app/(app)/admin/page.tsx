import { prisma } from '@/lib/db/prisma';
import AdminDashboard, { type InitialData } from '@/components/admin/AdminDashboard';

export const dynamic = 'force-dynamic';

function startOfTodayBeirut(): Date {
  const offsetMs = 3 * 60 * 60_000;
  const nowBeirut = new Date(Date.now() + offsetMs);
  const startOfDay = new Date(Date.UTC(nowBeirut.getUTCFullYear(), nowBeirut.getUTCMonth(), nowBeirut.getUTCDate(), 0, 0, 0, 0));
  return new Date(startOfDay.getTime() - offsetMs);
}

export default async function AdminHomePage() {
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
    }),
    prisma.flag.findMany({
      where: { created_at: { gte: startOfTodayBeirut() } },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: { user: { select: { username: true } }, branch: { select: { name: true } } },
    }),
  ]);

  const now = Date.now();
  const branchDriverMap = new Map<string, InitialData['branches'][number]['driversOut']>();
  for (const t of openTrips) {
    if (t.driver.role !== 'DRIVER') continue;
    const driverOut = {
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

  const initialData: InitialData = {
    branches: branchesRaw.map((b) => {
      const present: InitialData['branches'][number]['present'] = [];
      const absent: InitialData['branches'][number]['absent'] = [];
      for (const u of b.users) {
        const last = u.punches[0];
        if (last && last.kind === 'IN') {
          present.push({
            id: u.id,
            username: u.username,
            in_at: last.at.toISOString(),
            minutes_since_in: Math.max(0, Math.floor((now - last.at.getTime()) / 60_000)),
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
    }),
    flags: todayFlags.map((f) => ({
      id: f.id,
      kind: f.kind,
      user_id: f.user_id,
      username: f.user?.username ?? null,
      branch_id: f.branch_id,
      branch_name: f.branch?.name ?? null,
      context_json: f.context_json,
      created_at: f.created_at.toISOString(),
    })),
  };

  return <AdminDashboard initialData={initialData} />;
}