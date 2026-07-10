import { describe, it, expect, beforeAll } from 'vitest';
import { signToken, verifyToken, newJwtSecret } from './jwt';

beforeAll(() => {
  process.env.JWT_SECRET = newJwtSecret();
});

describe('jwt', () => {
  it('signs and verifies a valid token', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_1', role: 'ADMIN', branchId: null }, exp);
    const decoded = await verifyToken(tok);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe('user_1');
    expect(decoded?.role).toBe('ADMIN');
    expect(decoded?.branchId).toBeNull();
  });

  it('preserves branchId when present', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_2', role: 'EMPLOYEE', branchId: 'branch_99' }, exp);
    const decoded = await verifyToken(tok);
    expect(decoded?.branchId).toBe('branch_99');
  });

  it('rejects an expired token', async () => {
    const exp = new Date(Date.now() - 1000);
    const tok = await signToken({ sub: 'user_1', role: 'EMPLOYEE', branchId: null }, exp);
    const decoded = await verifyToken(tok);
    expect(decoded).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_1', role: 'EMPLOYEE', branchId: null }, exp);
    const tampered = tok.slice(0, -2) + (tok.endsWith('A') ? 'BB' : 'AA');
    const decoded = await verifyToken(tampered);
    expect(decoded).toBeNull();
  });

  it('rejects a token with invalid role', async () => {
    const exp = new Date(Date.now() + 60_000);
    const tok = await signToken({ sub: 'user_1', role: 'ADMIN', branchId: null }, exp);
    const parts = tok.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.role = 'HACKER';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');
    const decoded = await verifyToken(tampered);
    expect(decoded).toBeNull();
  });
});