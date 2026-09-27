import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Security #16: who is asking comes from the signed access cookie, checked
 * against the database - never from x-user-* request headers, which anyone
 * can send.
 */
const jar = new Map<string, string>();
const sent = new Headers();
vi.mock('next/headers', () => ({
  cookies: () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }),
  headers: () => sent,
}));

const users = new Map<string, { is_active: boolean; session_version: number }>();
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null),
    },
  },
}));

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'unit-test-secret-0123456789abcdef0123456789abcdef';

import { identity } from './identity';
import { signToken } from './jwt';
import { ACCESS_COOKIE_NAME } from './constants';

async function accessFor(sub: string, sv: number, role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE') {
  return signToken({ sub, role, branchId: null, sv }, new Date(Date.now() + 60_000), 'access');
}

beforeEach(() => {
  jar.clear();
  users.clear();
  for (const k of ['x-user-id', 'x-user-role', 'x-user-branch-id']) sent.delete(k);
});

describe('identity', () => {
  it('ignores x-user-* headers sent without a signed cookie', async () => {
    sent.set('x-user-id', 'forged');
    sent.set('x-user-role', 'ADMIN');
    expect(await identity()).toBeNull();
  });

  it('reads who is asking from the signed cookie, not from the headers', async () => {
    users.set('u1', { is_active: true, session_version: 3 });
    jar.set(ACCESS_COOKIE_NAME, await accessFor('u1', 3));
    sent.set('x-user-id', 'forged');
    sent.set('x-user-role', 'ADMIN');
    expect(await identity()).toEqual({ userId: 'u1', role: 'EMPLOYEE', branchId: null });
  });

  it('refuses a token from a session that has since been ended', async () => {
    users.set('u1', { is_active: true, session_version: 4 });
    jar.set(ACCESS_COOKIE_NAME, await accessFor('u1', 3));
    expect(await identity()).toBeNull();
  });

  it('refuses a token for somebody who has been retired', async () => {
    users.set('u1', { is_active: false, session_version: 3 });
    jar.set(ACCESS_COOKIE_NAME, await accessFor('u1', 3));
    expect(await identity()).toBeNull();
  });

  it('refuses a refresh token in the access cookie', async () => {
    users.set('u1', { is_active: true, session_version: 3 });
    jar.set(
      ACCESS_COOKIE_NAME,
      await signToken({ sub: 'u1', role: 'ADMIN', branchId: null, sv: 3 }, new Date(Date.now() + 60_000), 'refresh'),
    );
    expect(await identity()).toBeNull();
  });
});
