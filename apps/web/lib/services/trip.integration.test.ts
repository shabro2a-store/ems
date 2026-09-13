import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getTestPrisma,
  cleanDb,
  seedTestBranch,
  seedTestDriver,
} from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function postJson(url: string, init: { cookies: string; csrf: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey('itest-trip'),
      'X-CSRF-Token': init.csrf,
      Cookie: init.cookies,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** A JPEG skeleton with a frame header the server can read a size out of - what the camera would send. */
function fakeReceipt(width = 1080, height = 1920): Blob {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return new Blob([Buffer.concat([soi, sof, Buffer.from([0xff, 0xd9])])], { type: 'image/jpeg' });
}

/** Trip start is multipart: the receipt photo travels with the coordinates. `photo: null` leaves it out. */
async function postTripStart(init: {
  cookies: string;
  csrf: string;
  body: { lat: number; lng: number; accuracy: number };
  photo?: Blob | null;
}): Promise<{ status: number; body: unknown }> {
  const form = new FormData();
  form.set('lat', String(init.body.lat));
  form.set('lng', String(init.body.lng));
  form.set('accuracy', String(init.body.accuracy));
  if (init.photo !== null) form.set('photo', init.photo ?? fakeReceipt(), 'receipt.jpg');
  const res = await fetch(`${BASE_URL}/api/me/trip/start`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey('itest-trip'), 'X-CSRF-Token': init.csrf, Cookie: init.cookies },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

/** On shift and rung by the counter - what startTrip requires before it will look at anything else. */
async function dispatch(driver: { id: string }, branch: { id: string }) {
  const db = getTestPrisma();
  await db.punch.create({
    data: { user_id: driver.id, branch_id: branch.id, kind: 'IN', at: new Date(Date.now() - 60 * 60_000), lat: 33.8962, lng: 35.4827, accuracy_m: 10, device_fp: 'itest', ip: '127.0.0.1' },
  });
  await db.driverCall.create({ data: { driver_id: driver.id, caller_id: driver.id, branch_id: branch.id } });
}

describe('trip integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('driver starts a trip inside geofence, and the receipt is stored with it', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv1', branch_id: branch.id });
    await dispatch(driver, branch);
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const r = await postTripStart({ cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 } });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; data?: { trip_id: string } };
    expect(body.ok).toBe(true);
    const trip = await getTestPrisma().trip.findFirst({ where: { driver_id: driver.id }, include: { receipt: true } });
    expect(trip).not.toBeNull();
    expect(trip?.back_at).toBeNull();
    expect(trip?.receipt_taken_at).not.toBeNull();
    expect(trip?.receipt?.width).toBe(1080);
  });

  it('driver cannot start a trip without a receipt photo', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv1b', branch_id: branch.id });
    await dispatch(driver, branch);
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const r = await postTripStart({ cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 }, photo: null });
    expect(r.status).toBe(400);
    expect((r.body as { error?: { code: string } }).error?.code).toBe('RECEIPT_REQUIRED');
    // The old screen, sending JSON, gets the same answer.
    const old = await postJson('/api/me/trip/start', { cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 } });
    expect(old.status).toBe(400);
    expect(await getTestPrisma().trip.count({ where: { driver_id: driver.id } })).toBe(0);
  });

  it('driver cannot start a trip with a photo too small to read', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv1c', branch_id: branch.id });
    await dispatch(driver, branch);
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const r = await postTripStart({ cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 }, photo: fakeReceipt(320, 240) });
    expect(r.status).toBe(400);
    expect((r.body as { error?: { code: string } }).error?.code).toBe('BAD_PHOTO');
  });

  it('driver cannot start a 2nd trip while one is open', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv2', branch_id: branch.id });
    await dispatch(driver, branch);
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const r1 = await postTripStart({ cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 } });
    expect(r1.status).toBe(200);
    await dispatch(driver, branch); // rung again for the next order
    const r2 = await postTripStart({ cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 } });
    expect(r2.status).toBe(409);
    const body2 = r2.body as { error?: { code: string } };
    expect(body2.error?.code).toBe('OPEN_TRIP_EXISTS');
  });

  it('driver ends trip with duration_min > 0', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv3', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const outAt = new Date(Date.now() - 30 * 60_000);
    await getTestPrisma().trip.create({
      data: { driver_id: driver.id, branch_id: branch.id, out_at: outAt, out_lat: 33.8962, out_lng: 35.4827 },
    });
    const r = await postJson('/api/me/trip/end', {
      cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 },
    });
    expect(r.status).toBe(200);
    const body = r.body as { data?: { duration_min: number; back_at: string } };
    expect(body.data?.duration_min).toBeGreaterThanOrEqual(29);
    const trip = await getTestPrisma().trip.findFirst({ where: { driver_id: driver.id }, orderBy: { out_at: 'desc' } });
    expect(trip?.back_at).not.toBeNull();
  });

  it('driver end trip from outside geofence returns 422', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 50 });
    const driver = await seedTestDriver({ username: 'trip-drv4', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    await getTestPrisma().trip.create({
      data: { driver_id: driver.id, branch_id: branch.id, out_at: new Date(), out_lat: 33.8962, out_lng: 35.4827 },
    });
    const r = await postJson('/api/me/trip/end', {
      cookies, csrf, body: { lat: 33.91, lng: 35.5, accuracy: 10 },
    });
    expect(r.status).toBe(422);
  });

  it('non-driver cannot start a trip', async () => {
    const branch = await seedTestBranch();
    const { seedTestUser } = await import('../test-helpers/db');
    const employee = await seedTestUser({ username: 'trip-emp', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(employee.username, 'change-me');
    const r = await postTripStart({ cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 } });
    expect(r.status).toBe(403);
  });
});