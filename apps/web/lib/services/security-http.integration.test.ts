import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser, seedTestDriver } from '../test-helpers/db';
import { loginAs, type LoginSession } from '../test-helpers/auth';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

async function post(session: LoginSession, path: string, body: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookies,
      'X-CSRF-Token': session.csrf,
      'Idempotency-Key': `sec-${Date.now()}-${Math.random()}`,
    },
    body: JSON.stringify(body),
  });
}

const actions = async () => (await getTestPrisma().auditLog.findMany({ orderBy: { at: 'asc' } })).map((a) => a.action);

function fakeReceipt(): Blob {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(1920, 5);
  sof.writeUInt16BE(1080, 7);
  sof[9] = 3;
  return new Blob([Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])], { type: 'image/jpeg' });
}

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await getTestPrisma().$disconnect();
});

/*
 * Security #10: push-subscribe stored any URL as a "push endpoint", and the
 * server then POSTs to it - so a signed-in user could make the server call
 * addresses only it can reach (the database, the metadata service).
 */
describe('push subscriptions', () => {
  it('are refused for anything that is not a push service', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'push-emp', branch_id: branch.id });
    const s = await loginAs('push-emp', 'test-pass-1');
    const keys = { p256dh: 'BExample', auth: 'secret' };
    for (const endpoint of ['http://127.0.0.1:5432/', 'https://169.254.169.254/latest/meta-data', 'https://evil.example/fcm.googleapis.com/x']) {
      expect((await post(s, '/api/me/push/subscribe', { endpoint, keys })).status).toBe(400);
    }
    expect(await getTestPrisma().pushSubscription.count()).toBe(0);
    expect((await post(s, '/api/me/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys })).status).toBe(200);
  });
});

/* Security #12: no security headers, and X-Powered-By announced the framework. */
describe('every page', () => {
  it('is sent with security headers and without X-Powered-By', async () => {
    const res = await fetch(`${BASE_URL}/login`);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('strict-transport-security') ?? '').toContain('max-age=');
  });
});

/*
 * Security #8: the receipt upload was read whole into memory before its size
 * was checked, so one large request could take the web container down.
 */
describe('a trip-start upload', () => {
  it('that says it is too large is refused before it is read', async () => {
    const branch = await seedTestBranch();
    await seedTestDriver({ username: 'big-drv', branch_id: branch.id });
    const s = await loginAs('big-drv', 'test-pass-1');
    const res = await fetch(`${BASE_URL}/api/me/trip/start`, {
      method: 'POST',
      headers: {
        Cookie: s.cookies,
        'X-CSRF-Token': s.csrf,
        'Idempotency-Key': `big-${Date.now()}`,
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': String(50 * 1024 * 1024),
      },
      body: 'x',
    }).catch((e: Error) => e);
    // Either answered 413 at once, or hung up on before the body was sent.
    if (res instanceof Error) return;
    expect(res.status).toBe(413);
  });
});

/*
 * Security #15: signing in and out, failed sign-ins, trips, rings, answering a
 * ring and registering a phone for pushes left no audit trail.
 */
describe('the audit log', () => {
  it('records signing in, a failed sign-in and signing out', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'aud-emp', branch_id: branch.id });
    await expect(loginAs('aud-emp', 'wrong-password')).rejects.toThrow();
    const s = await loginAs('aud-emp', 'test-pass-1');
    await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST', headers: { Cookie: s.cookies, 'X-CSRF-Token': s.csrf } });
    expect(await actions()).toEqual(['auth.login_failed', 'auth.login', 'auth.logout']);
  });

  it('records a phone registered for pushes', async () => {
    const branch = await seedTestBranch();
    await seedTestUser({ username: 'aud-push', branch_id: branch.id });
    const s = await loginAs('aud-push', 'test-pass-1');
    await post(s, '/api/me/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/aud', keys: { p256dh: 'B', auth: 'a' } });
    expect(await actions()).toContain('push.subscribe');
  });

  it('records a ring, its answer, and the trip that follows', async () => {
    const db = getTestPrisma();
    const branch = await seedTestBranch({ gps_radius_m: 200 });
    const driver = await seedTestDriver({ username: 'aud-drv', branch_id: branch.id });
    await seedTestUser({ username: 'aud-caller', role: Role.CALLER, branch_id: branch.id });
    await db.punch.create({
      data: { user_id: driver.id, branch_id: branch.id, kind: 'IN', at: new Date(Date.now() - 60 * 60_000), lat: 33.8962, lng: 35.4827, accuracy_m: 10, device_fp: 'itest', ip: '127.0.0.1' },
    });
    const caller = await loginAs('aud-caller', 'test-pass-1');
    const drv = await loginAs('aud-drv', 'test-pass-1');

    expect((await post(caller, '/api/caller/ring', { driverId: driver.id })).status).toBe(200);
    expect((await post(drv, '/api/me/calls/ack', {})).status).toBe(200);

    const form = new FormData();
    form.set('lat', '33.8962');
    form.set('lng', '35.4827');
    form.set('accuracy', '10');
    form.set('photo', fakeReceipt(), 'receipt.jpg');
    const start = await fetch(`${BASE_URL}/api/me/trip/start`, {
      method: 'POST',
      headers: { Cookie: drv.cookies, 'X-CSRF-Token': drv.csrf, 'Idempotency-Key': `aud-trip-${Date.now()}` },
      body: form,
    });
    expect(start.status).toBe(200);
    expect((await post(drv, '/api/me/trip/end', { lat: 33.8962, lng: 35.4827, accuracy: 10 })).status).toBe(200);

    const done = await actions();
    for (const a of ['call.ring', 'call.ack', 'trip.start', 'trip.end']) expect(done).toContain(a);
  });
});
