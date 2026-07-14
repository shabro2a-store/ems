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

describe('trip integration', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('driver starts a trip inside geofence', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv1', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const r = await postJson('/api/me/trip/start', {
      cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 },
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; data?: { trip_id: string } };
    expect(body.ok).toBe(true);
    const trip = await getTestPrisma().trip.findFirst({ where: { driver_id: driver.id } });
    expect(trip).not.toBeNull();
    expect(trip?.back_at).toBeNull();
  });

  it('driver cannot start a 2nd trip while one is open', async () => {
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'trip-drv2', branch_id: branch.id });
    const { cookies, csrf } = await loginAs(driver.username, 'change-me');
    const r1 = await postJson('/api/me/trip/start', {
      cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 },
    });
    expect(r1.status).toBe(200);
    const r2 = await postJson('/api/me/trip/start', {
      cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 },
    });
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
    const r = await postJson('/api/me/trip/start', {
      cookies, csrf, body: { lat: 33.8962, lng: 35.4827, accuracy: 10 },
    });
    expect(r.status).toBe(403);
  });
});