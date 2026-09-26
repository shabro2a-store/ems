import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

/*
 * CVE-2025-29927. Next before 14.2.25 skipped the middleware for any request
 * claiming, in `x-middleware-subrequest`, to be one of its own recursive calls.
 * Every route here trusts the x-user-* headers the middleware sets, so a
 * skipped middleware let a stranger send those headers themselves and be ADMIN.
 * The route never runs: an unauthenticated request stops at the middleware.
 */
const SKIP_CLAIMS = [
  'middleware:middleware:middleware:middleware:middleware',
  'src/middleware:src/middleware:src/middleware:src/middleware:src/middleware',
];

const forged = (claim: string) => ({
  'x-middleware-subrequest': claim,
  'x-user-id': 'forged-admin',
  'x-user-role': 'ADMIN',
});

describe('a request that claims to be the middleware calling itself', () => {
  for (const claim of SKIP_CLAIMS) {
    it(`is still refused on an admin read (${claim.split(':')[0]})`, async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users`, { headers: forged(claim) });
      expect(res.status).toBe(401);
    });

    it(`is still refused on an admin write (${claim.split(':')[0]})`, async () => {
      // The attacker holds both halves of the double-submit CSRF pair, so it
      // stops nothing on its own; only the middleware does.
      const res = await fetch(`${BASE_URL}/api/admin/users/anyone/reset-password`, {
        method: 'POST',
        headers: {
          ...forged(claim),
          'content-type': 'application/json',
          cookie: 'csrf=a',
          'x-csrf-token': 'a',
          'idempotency-key': `bypass-${Date.now()}`,
        },
        body: JSON.stringify({ password: 'taken-over-123' }),
      });
      expect(res.status).toBe(401);
    });
  }
});
