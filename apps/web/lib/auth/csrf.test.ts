import { describe, it, expect } from 'vitest';
import { generateCsrfToken, validateCsrf, constantTimeEqual } from './csrf';

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
});