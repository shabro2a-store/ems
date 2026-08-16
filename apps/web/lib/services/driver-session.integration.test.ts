import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Role } from '@prisma/client';
import { getTestPrisma, cleanDb, seedTestBranch, seedTestUser } from '../test-helpers/db';
import { loginAs } from '../test-helpers/auth';
import {
  SESSION_TTL_EMPLOYEE_MIN,
  SESSION_TTL_DRIVER_CHECKED_IN_MIN,
  ACCESS_COOKIE_NAME,
} from '../auth/constants';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function setCookieList(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.bind(headers);
  if (getSetCookie) return getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=[^;]+=)/).map((c) => c.trim()) : [];
}

function cookieValue(source: string | string[], name: string): string | null {
  const parts = Array.isArray(source) ? source : source.split(/;\s*/);
  for (const part of parts) {
    const first = part.split(';')[0]!.trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    if (first.slice(0, eq).trim() === name) return first.slice(eq + 1).trim();
  }
  return null;
}

// The session length lives in the token's exp, not in anything the response
// body says, so the assertion has to read the token the server actually issued.
function ttlMinutes(jwt: string): number {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number };
  return Math.round((payload.exp - Date.now() / 1000) / 60);
}

async function punch(session: { cookies: string; csrf: string }, kind: 'IN' | 'OUT'): Promise<Response> {
  return fetch(`${BASE_URL}/api/me/punch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `ds-${kind}-${Date.now()}-${Math.random()}`,
      'X-CSRF-Token': session.csrf,
      Cookie: session.cookies,
    },
    body: JSON.stringify({ kind, lat: 33.89621, lng: 35.48271, accuracy: 12, deviceFp: 'test-fp-ds' }),
  });
}

// sessionExpiryFor has always returned 12h for a checked-in driver when handed
// hasOpenPunch: true, and its unit tests passed on that. What failed was the
// caller: login was the only place it ran, and a driver must sign in BEFORE they
// can punch, so the flag was false every time it was read and drivers kept the
// 2h employee session through an 8h shift. These tests drive the real HTTP flow
// in the order a driver actually performs it.
describe('driver session TTL across the punch flow (HTTP)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await getTestPrisma().$disconnect();
  });

  it('gives a driver the checked-in TTL on punch IN and the standard TTL on punch OUT', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const driver = await seedTestUser({ username: 'ds-driver', role: Role.DRIVER, branch_id: branch.id });
    const session = await loginAs(driver.username, 'change-me');

    // At login the driver has no open punch, so the standard TTL is correct here.
    const atLogin = cookieValue(session.cookies, ACCESS_COOKIE_NAME);
    expect(atLogin).toBeTruthy();
    expect(ttlMinutes(atLogin!)).toBeGreaterThan(SESSION_TTL_EMPLOYEE_MIN - 5);
    expect(ttlMinutes(atLogin!)).toBeLessThanOrEqual(SESSION_TTL_EMPLOYEE_MIN);

    const inRes = await punch(session, 'IN');
    expect(inRes.status).toBe(200);
    const afterIn = cookieValue(setCookieList(inRes.headers), ACCESS_COOKIE_NAME);
    expect(afterIn).toBeTruthy();
    expect(ttlMinutes(afterIn!)).toBeGreaterThan(SESSION_TTL_DRIVER_CHECKED_IN_MIN - 5);
    expect(ttlMinutes(afterIn!)).toBeLessThanOrEqual(SESSION_TTL_DRIVER_CHECKED_IN_MIN);
    // The whole point: the session now outlasts any shift the shop runs.
    expect(ttlMinutes(afterIn!)).toBeGreaterThan(SESSION_TTL_EMPLOYEE_MIN);

    // The re-issued token must still be a usable session for the same driver.
    const stillIn = await fetch(`${BASE_URL}/api/me/today`, {
      headers: { Cookie: `${ACCESS_COOKIE_NAME}=${afterIn}`, 'X-CSRF-Token': session.csrf },
    });
    expect(stillIn.status).toBe(200);

    const outRes = await punch({ cookies: `${ACCESS_COOKIE_NAME}=${afterIn}; csrf=${session.csrf}`, csrf: session.csrf }, 'OUT');
    expect(outRes.status).toBe(200);
    const afterOut = cookieValue(setCookieList(outRes.headers), ACCESS_COOKIE_NAME);
    expect(afterOut).toBeTruthy();
    expect(ttlMinutes(afterOut!)).toBeGreaterThan(SESSION_TTL_EMPLOYEE_MIN - 5);
    expect(ttlMinutes(afterOut!)).toBeLessThanOrEqual(SESSION_TTL_EMPLOYEE_MIN);
  });

  it('leaves an EMPLOYEE session untouched by punching', async () => {
    const branch = await seedTestBranch({ name: 'Hamra', lat: 33.8962, lng: 35.4827, gps_radius_m: 200 });
    const emp = await seedTestUser({ username: 'ds-emp', role: Role.EMPLOYEE, branch_id: branch.id });
    const session = await loginAs(emp.username, 'change-me');

    const inRes = await punch(session, 'IN');
    expect(inRes.status).toBe(200);
    expect(cookieValue(setCookieList(inRes.headers), ACCESS_COOKIE_NAME)).toBeNull();
  });
});
