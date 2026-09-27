import { describe, it, expect } from 'vitest';
import { readBodyLimited } from './readLimited';
import { isPushServiceEndpoint } from 'notify';

/*
 * Security #8: req.formData() reads the whole body before anything can look
 * at its size. This reads at most the limit, then stops and cancels the rest.
 */
function endless(chunk = 64 * 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled += chunk;
      c.enqueue(new Uint8Array(chunk));
    },
  });
  return { stream, pulled: () => pulled };
}

describe('readBodyLimited', () => {
  it('stops reading once the body passes the limit', async () => {
    const src = endless();
    const req = new Request('http://x/', { method: 'POST', body: src.stream, duplex: 'half' } as RequestInit);
    expect(await readBodyLimited(req, 1024 * 1024)).toBe('TOO_LARGE');
    expect(src.pulled()).toBeLessThan(2 * 1024 * 1024);
  });

  it('refuses at once a body that says it is too large', async () => {
    const src = endless();
    const req = new Request('http://x/', {
      method: 'POST',
      body: src.stream,
      headers: { 'content-length': String(50 * 1024 * 1024) },
      duplex: 'half',
    } as RequestInit);
    expect(await readBodyLimited(req, 1024 * 1024)).toBe('TOO_LARGE');
    expect(src.pulled()).toBeLessThanOrEqual(64 * 1024);
  });

  it('returns a body within the limit whole', async () => {
    const req = new Request('http://x/', { method: 'POST', body: 'hello' });
    const got = await readBodyLimited(req, 1024);
    expect(got).not.toBe('TOO_LARGE');
    expect(new TextDecoder().decode(got as Uint8Array)).toBe('hello');
  });
});

/* Security #10: only the browsers' push services are ever called. */
describe('isPushServiceEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (url) => {
    expect(isPushServiceEndpoint(url)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.example/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user@fcm.googleapis.com/x',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isPushServiceEndpoint(url)).toBe(false);
  });
});
