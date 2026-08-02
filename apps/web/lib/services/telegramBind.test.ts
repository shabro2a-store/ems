import { describe, it, expect, beforeAll } from 'vitest';
import { currentBindCode, verifyBindCode, BIND_CODE_TTL_MS } from './telegramBind';

const ADMIN = 'admin-id-1';

describe('telegram bind code', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-for-bind-code-0123456789';
  });

  it('issues a 6-digit code that verifies', () => {
    const now = new Date('2026-08-02T10:00:00Z');
    const { code } = currentBindCode(ADMIN, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyBindCode(ADMIN, code, now)).toBe(true);
  });

  it('rejects a code issued for a different admin', () => {
    const now = new Date('2026-08-02T10:00:00Z');
    const { code } = currentBindCode('someone-else', now);
    expect(verifyBindCode(ADMIN, code, now)).toBe(false);
  });

  it('still accepts a code from the previous window (rollover grace)', () => {
    const now = new Date('2026-08-02T10:00:00Z');
    const { code } = currentBindCode(ADMIN, now);
    const later = new Date(now.getTime() + BIND_CODE_TTL_MS);
    expect(verifyBindCode(ADMIN, code, later)).toBe(true);
  });

  it('rejects a code once two windows have passed', () => {
    const now = new Date('2026-08-02T10:00:00Z');
    const { code } = currentBindCode(ADMIN, now);
    const tooLate = new Date(now.getTime() + BIND_CODE_TTL_MS * 2);
    expect(verifyBindCode(ADMIN, code, tooLate)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    const now = new Date('2026-08-02T10:00:00Z');
    for (const bad of ['', 'abcdef', '12345', '1234567', '  ']) {
      expect(verifyBindCode(ADMIN, bad, now)).toBe(false);
    }
  });

  it('reports a positive expiry inside the window', () => {
    const { expiresInSec } = currentBindCode(ADMIN, new Date('2026-08-02T10:00:00Z'));
    expect(expiresInSec).toBeGreaterThan(0);
    expect(expiresInSec).toBeLessThanOrEqual(BIND_CODE_TTL_MS / 1000);
  });
});
