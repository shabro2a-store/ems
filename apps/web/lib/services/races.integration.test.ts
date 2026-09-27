import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestDriver, seedTestUser } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';
import { writeSystemCheckout } from './autoClose';
import { endTrip } from './trip';
import { prisma } from '@/lib/db/prisma';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * #40, the races:
 *  - the system-checkout writers re-read for a checkout but did not take the
 *    per-person punch lock, so two at once both saw "none" and both wrote one;
 *  - a double tap on "out on an order" sent two trip starts; the second hit the
 *    one-open-trip index and came back as a 500;
 *  - trip end read the open trip, then updated it by id - overwriting a close
 *    the sweep had written in between.
 */
describe('races', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('writes one system checkout when two writers close the same session at once', async () => {
    const branch = await seedTestBranch();
    const emp = await seedTestUser({ username: 'race-emp', branch_id: branch.id });
    const arrival = await getTestPrisma().punch.create({
      data: { user_id: emp.id, branch_id: branch.id, kind: 'IN', at: new Date(Date.now() - 30 * 3_600_000), lat: 33.8962, lng: 35.4827, accuracy_m: 10, device_fp: 'itest', ip: '127.0.0.1' },
    });
    const close = () =>
      writeSystemCheckout(prisma, {
        userId: emp.id,
        branchId: branch.id,
        branchLat: 33.8962,
        branchLng: 35.4827,
        arrivalAt: arrival.at,
        arrivalPunchId: arrival.id,
        closeAt: new Date(arrival.at.getTime() + 8 * 3_600_000),
        requiredMin: 480,
        now: new Date(),
        trigger: 'abandoned_sweep',
        reason: 'race test',
      });
    await Promise.all([close(), close(), close()]);
    expect(await getTestPrisma().punch.count({ where: { user_id: emp.id, kind: 'OUT' } })).toBe(1);
  });

  it('answers a double tap on trip start with a refusal, not a server error', async () => {
    const db = getTestPrisma();
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'race-drv', branch_id: branch.id });
    await db.punch.create({
      data: { user_id: driver.id, branch_id: branch.id, kind: 'IN', at: new Date(Date.now() - 3_600_000), lat: 33.8962, lng: 35.4827, accuracy_m: 10, device_fp: 'itest', ip: '127.0.0.1' },
    });
    await db.driverCall.create({ data: { driver_id: driver.id, caller_id: driver.id, branch_id: branch.id } });
    const s = await loginAs('race-drv', 'test-pass-1');
    const sof = Buffer.alloc(19);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(1920, 5);
    sof.writeUInt16BE(1080, 7);
    sof[9] = 3;
    const photo = new Blob([Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])], { type: 'image/jpeg' });
    const start = (key: string) => {
      const form = new FormData();
      form.set('lat', '33.8962');
      form.set('lng', '35.4827');
      form.set('accuracy', '10');
      form.set('photo', photo, 'receipt.jpg');
      return fetch(`${BASE_URL}/api/me/trip/start`, {
        method: 'POST',
        headers: { Cookie: s.cookies, 'X-CSRF-Token': s.csrf, 'Idempotency-Key': key },
        body: form,
      });
    };
    const statuses = (await Promise.all([start('tap-1'), start('tap-2'), start('tap-3')])).map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(statuses.some((x) => x >= 500)).toBe(false);
    expect(await db.trip.count({ where: { driver_id: driver.id } })).toBe(1);
  });

  it('leaves a trip the sweep closed as the sweep closed it', async () => {
    const db = getTestPrisma();
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'race-back', branch_id: branch.id });
    const trip = await db.trip.create({
      data: { driver_id: driver.id, branch_id: branch.id, out_at: new Date(Date.now() - 5 * 3_600_000), out_lat: 33.8962, out_lng: 35.4827 },
    });
    const sweptAt = new Date(Date.now() - 60 * 60_000);
    // The sweep lands between endTrip reading the open trip and writing it.
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== 'trip') return Reflect.get(target, prop, receiver);
        return new Proxy(target.trip, {
          get(t, p, r) {
            if (p !== 'findFirst') return Reflect.get(t, p, r);
            return async (args: unknown) => {
              const found = await t.findFirst(args as never);
              await db.trip.update({ where: { id: trip.id }, data: { back_at: sweptAt, system_generated: true } });
              return found;
            };
          },
        });
      },
    }) as PrismaClient;

    const r = await endTrip({ userId: driver.id, lat: 33.8962, lng: 35.4827, accuracy: 10 }, racing);
    expect(r.ok).toBe(false);
    const after = await db.trip.findUnique({ where: { id: trip.id } });
    expect(after!.back_at!.getTime()).toBe(sweptAt.getTime());
  });
});
