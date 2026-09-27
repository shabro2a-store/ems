import { describe, it, expect } from 'vitest';
import { requestCookie } from './requestCookie';

const req = (cookie: string) => new Request('http://x/', { headers: { cookie } });

describe('requestCookie', () => {
  it('finds a cookie wherever it sits in the header', () => {
    expect(requestCookie(req('ems_refresh=r1'), 'ems_refresh')).toBe('r1');
    expect(requestCookie(req('csrf=c; ems_refresh=r2'), 'ems_refresh')).toBe('r2');
    expect(requestCookie(req('a=1;ems_refresh=r3;b=2'), 'ems_refresh')).toBe('r3');
  });

  it('does not confuse a cookie with one whose name ends the same way', () => {
    expect(requestCookie(req('xems_refresh=no; ems_refresh=yes'), 'ems_refresh')).toBe('yes');
    expect(requestCookie(req('xems_refresh=no'), 'ems_refresh')).toBeUndefined();
  });

  it('keeps an = inside the value', () => {
    expect(requestCookie(req('csrf=abc=='), 'csrf')).toBe('abc==');
  });

  it('is undefined with no header or an empty value', () => {
    expect(requestCookie(new Request('http://x/'), 'csrf')).toBeUndefined();
    expect(requestCookie(req('csrf='), 'csrf')).toBeUndefined();
  });
});
