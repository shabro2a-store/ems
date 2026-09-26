import { describe, it, expect, beforeAll } from 'vitest';
import { signToken, verifyToken, newJwtSecret } from './jwt';

beforeAll(() => {
  process.env.JWT_SECRET = newJwtSecret();
});

describe('jwt', () => {
  it('signs and verifies a valid token', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_1', role: 'ADMIN', branchId: null, sv: 0 }, exp, 'access');
    const decoded = await verifyToken(tok, 'access');
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe('user_1');
    expect(decoded?.role).toBe('ADMIN');
    expect(decoded?.branchId).toBeNull();
  });

  it('preserves branchId when present', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_2', role: 'EMPLOYEE', branchId: 'branch_99', sv: 0 }, exp, 'access');
    const decoded = await verifyToken(tok, 'access');
    expect(decoded?.branchId).toBe('branch_99');
  });

  it('rejects an expired token', async () => {
    const exp = new Date(Date.now() - 1000);
    const tok = await signToken({ sub: 'user_1', role: 'EMPLOYEE', branchId: null, sv: 0 }, exp, 'access');
    const decoded = await verifyToken(tok, 'access');
    expect(decoded).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_1', role: 'EMPLOYEE', branchId: null, sv: 0 }, exp, 'access');
    const tampered = tok.slice(0, -2) + (tok.endsWith('A') ? 'BB' : 'AA');
    const decoded = await verifyToken(tampered, 'access');
    expect(decoded).toBeNull();
  });

  it('rejects a token with invalid role', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_1', role: 'ADMIN', branchId: null, sv: 0 }, exp, 'access');
    const parts = tok.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.role = 'HACKER';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');
    const decoded = await verifyToken(tampered, 'access');
    expect(decoded).toBeNull();
  });
});

describe('token kinds', () => {
  // The refresh token lives 7 days and the access token two hours. Signed with
  // the same key and the same claims, a refresh token copied into the access
  // cookie was simply accepted - a week of access that nothing could shorten.
  const exp = () => new Date(Date.now() + 60_000);
  const who = { sub: 'user_1', role: 'EMPLOYEE' as const, branchId: null, sv: 3 };

  it('refuses a refresh token where an access token is required', async () => {
    const refresh = await signToken(who, exp(), 'refresh');
    expect(await verifyToken(refresh, 'access')).toBeNull();
    expect(await verifyToken(refresh, 'refresh')).not.toBeNull();
  });

  it('refuses an access token where a refresh token is required', async () => {
    const access = await signToken(who, exp(), 'access');
    expect(await verifyToken(access, 'refresh')).toBeNull();
  });

  it('refuses a token from before kinds existed', async () => {
    const { SignJWT } = await import('jose');
    const legacy = await new SignJWT({ role: 'EMPLOYEE', branchId: null })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_1')
      .setExpirationTime(Math.floor(exp().getTime() / 1000))
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(await verifyToken(legacy, 'access')).toBeNull();
    expect(await verifyToken(legacy, 'refresh')).toBeNull();
  });

  it('carries the session version it was issued under', async () => {
    const t = await signToken(who, exp(), 'refresh');
    expect((await verifyToken(t, 'refresh'))?.sv).toBe(3);
  });
});
