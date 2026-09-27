import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestDriver } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * Money #31, the small figures: the caller board counted trips the owner had
 * denied, and the dashboard's labour cost today left out trip pay entirely.
 */
describe('a driver with a denied trip today', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  async function driverOut(username: string) {
    const db = getTestPrisma();
    const branch = await seedTestBranch();
    const driver = await seedTestDriver({ username, branch_id: branch.id, hourly_rate_cent: 0 });
    await db.user.update({ where: { id: driver.id }, data: { trip_rate_cent: 150 } });
    await db.tripRateChange.create({ data: { user_id: driver.id, rate_cent: 150, effective_from: new Date(Date.now() - 86_400_000) } });
    const hour = 60 * 60_000;
    await db.punch.create({
      data: { user_id: driver.id, branch_id: branch.id, kind: 'IN', at: new Date(Date.now() - 3 * hour), lat: 33.8962, lng: 35.4827, accuracy_m: 10, device_fp: 'itest', ip: '127.0.0.1' },
    });
    const trip = (outAgo: number, denied: boolean) =>
      db.trip.create({
        data: {
          driver_id: driver.id,
          branch_id: branch.id,
          out_at: new Date(Date.now() - outAgo),
          back_at: new Date(Date.now() - outAgo + 20 * 60_000),
          out_lat: 33.8962,
          out_lng: 35.4827,
          ...(denied ? { denied_at: new Date(), denied_by: driver.id } : {}),
        },
      });
    await trip(2 * hour, false);
    await trip(1 * hour, true);
    return { branch, driver };
  }

  it('is not counted for the denied trip on the caller board', async () => {
    const { branch, driver } = await driverOut('fig-drv1');
    await seedTestUser({ username: 'fig-caller', role: Role.CALLER, branch_id: branch.id });
    const caller = await loginAs('fig-caller', 'test-pass-1');
    const res = await fetch(`${BASE_URL}/api/caller/drivers`, { headers: { Cookie: caller.cookies } });
    const drivers = ((await res.json()) as { data: { drivers: Array<{ id: string; trips_today: number }> } }).data.drivers;
    expect(drivers.find((d) => d.id === driver.id)!.trips_today).toBe(1);
  });

  it("puts the paid trip in the dashboard's labour cost today", async () => {
    await driverOut('fig-drv2');
    await seedTestUser({ username: 'fig-admin', role: Role.ADMIN });
    const admin = await loginAs('fig-admin', 'test-pass-1');
    const res = await fetch(`${BASE_URL}/api/admin/overview?branchId=all`, { headers: { Cookie: admin.cookies } });
    const kpis = ((await res.json()) as { data: { kpis: { laborTodayCent: number } } }).data.kpis;
    expect(kpis.laborTodayCent).toBe(150);
  });
});
