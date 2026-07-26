import { describe, it, expect } from 'vitest';
import { generateCsrfToken, validateCsrf, constantTimeEqual, csrfFromRequest } from './csrf';
import { CSRF_COOKIE_NAME } from './constants';

function reqWith(cookieValue: string, headerValue: string): Request {
  return new Request('http://localhost/api/x', {
    method: 'POST',
    headers: {
      cookie: `${CSRF_COOKIE_NAME}=${cookieValue}`,
      'x-csrf-token': headerValue,
    },
  });
}

describe('csrf', () => {
  it('generates a base64 string of the expected length', () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decoded = Buffer.from(t, 'base64');
    expect(decoded.length).toBe(32);
  });

  it('generates distinct tokens', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
  });

  it('validates matching cookie and header', () => {
    const t = generateCsrfToken();
    expect(validateCsrf(t, t)).toBe(true);
  });

  it('rejects mismatched cookie and header', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(validateCsrf(a, b)).toBe(false);
  });

  it('rejects when cookie is missing', () => {
    expect(validateCsrf(undefined, 'x')).toBe(false);
    expect(validateCsrf('x', undefined)).toBe(false);
  });

  it('rejects different lengths', () => {
    expect(validateCsrf('short', 'much-longer-token')).toBe(false);
  });

  it('constantTimeEqual returns true for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
  });

  it('constantTimeEqual returns false for different strings', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  describe('csrfFromRequest', () => {
    // Next.js writes the cookie URL-encoded; browsers echo it back in that same
    // encoded form in both the Cookie header and document.cookie. Both sides must
    // normalize to accept it. This token intentionally contains +, / and =.
    const token = 'BmXPAn5YdXYra/X/nTLkxVTPNBeTfJpHVq5pd2Otz+A=';
    const encoded = encodeURIComponent(token);

    it('accepts an URL-encoded cookie with an URL-encoded header (browser flow)', () => {
      expect(csrfFromRequest(reqWith(encoded, encoded))).toBe(true);
    });

    it('accepts an URL-encoded cookie with a decoded header', () => {
      expect(csrfFromRequest(reqWith(encoded, token))).toBe(true);
    });

    it('accepts a plain cookie with a plain header', () => {
      expect(csrfFromRequest(reqWith(token, token))).toBe(true);
    });

    it('rejects when tokens differ', () => {
      expect(csrfFromRequest(reqWith(encoded, encodeURIComponent(generateCsrfToken())))).toBe(false);
    });

    it('rejects when header is absent', () => {
      const req = new Request('http://localhost/api/x', {
        method: 'POST',
        headers: { cookie: `${CSRF_COOKIE_NAME}=${encoded}` },
      });
      expect(csrfFromRequest(req)).toBe(false);
    });
  });
});