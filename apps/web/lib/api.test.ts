import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiGet, apiSend } from './api';

/*
 * #44: nothing ever renewed a session. After two hours every request answered
 * 401 and every screen kept showing what it last had - the caller's board still
 * "Ringing…", the dashboard's dot still green - while nothing was sent. The
 * client now renews once on a 401 and repeats the request; if the session
 * really has ended, it goes to the sign-in page instead of freezing.
 */
type Call = { url: string; init: RequestInit | undefined };

let calls: Call[];
let jar: string;
let location: { href: string; assign: (u: string) => void };

function respond(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function serve(handler: (url: string, n: number) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return handler(url, calls.length);
    }),
  );
}

beforeEach(() => {
  jar = 'csrf=first';
  location = { href: '/admin', assign: (u: string) => { location.href = u; } };
  vi.stubGlobal('document', { get cookie() { return jar; } });
  vi.stubGlobal('window', { location });
});

// Every test file shares one process: a fetch left stubbed here answered the
// rest of the suite's HTTP tests with these fakes.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a request whose session has lapsed', () => {
  it('renews the session once and repeats the request', async () => {
    let renewed = false;
    serve((url) => {
      if (url === '/api/auth/refresh') { renewed = true; jar = 'csrf=second'; return respond(200, { ok: true, data: {} }); }
      return renewed ? respond(200, { ok: true, data: { n: 1 } }) : respond(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    expect(await apiGet('/api/admin/overview')).toEqual({ ok: true, data: { n: 1 } });
    expect(calls.map((c) => c.url)).toEqual(['/api/admin/overview', '/api/auth/refresh', '/api/admin/overview']);
  });

  it('renews once for many requests that lapse together', async () => {
    let renewed = false;
    serve(async (url) => {
      if (url === '/api/auth/refresh') { await new Promise((r) => setTimeout(r, 10)); renewed = true; return respond(200, { ok: true, data: {} }); }
      return renewed ? respond(200, { ok: true, data: {} }) : respond(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    await Promise.all([apiGet('/api/me/calls'), apiGet('/api/me/today'), apiGet('/api/me/calls')]);
    expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(1);
  });

  it('repeats a write with the same idempotency key and the new CSRF token', async () => {
    let renewed = false;
    serve((url) => {
      if (url === '/api/auth/refresh') { renewed = true; jar = 'csrf=second'; return respond(200, { ok: true, data: {} }); }
      return renewed ? respond(200, { ok: true, data: {} }) : respond(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    await apiSend('/api/me/advances', { body: { amountCent: 100 }, idempotent: true });
    const [first, , second] = calls.map((c) => c.init?.headers as Record<string, string>);
    expect(second!['Idempotency-Key']).toBe(first!['Idempotency-Key']);
    expect(first!['X-CSRF-Token']).toBe('first');
    expect(second!['X-CSRF-Token']).toBe('second');
  });

  it('goes to the sign-in page when the session has really ended', async () => {
    serve((url) =>
      url === '/api/auth/refresh'
        ? respond(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Session ended' } })
        : respond(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'x' } }),
    );
    const r = await apiGet('/api/caller/drivers');
    expect(r.ok).toBe(false);
    expect(location.href).toBe('/login');
  });

  it('leaves a wrong password on the sign-in form alone', async () => {
    serve(() => respond(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } }));
    const r = await apiSend('/api/auth/login', { body: { username: 'a', password: 'b' } });
    expect(r).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
    expect(calls).toHaveLength(1);
    expect(location.href).toBe('/admin');
  });
});

describe('sending the same thing twice', () => {
  it('goes out once when the second tap lands while the first is still on its way', async () => {
    let release: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((r) => { release = r; }));
    const a = apiSend('/api/admin/adjustments', { body: { userId: 'u', amountCent: 5000 }, idempotent: true });
    const b = apiSend('/api/admin/adjustments', { body: { userId: 'u', amountCent: 5000 }, idempotent: true });
    release(respond(200, { ok: true, data: { id: 'a1' } }));
    expect(await a).toEqual(await b);
    expect(calls).toHaveLength(1);
  });

  it('retries with the same key when the first attempt\'s outcome is unknown', async () => {
    let n = 0;
    serve(() => {
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      return respond(200, { ok: true, data: {} });
    });
    const body = { body: { userId: 'u', amountCent: 5000 }, idempotent: true };
    expect((await apiSend('/api/admin/adjustments', body)).ok).toBe(false);
    await apiSend('/api/admin/adjustments', body);
    const keys = calls.map((c) => (c.init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[1]).toBe(keys[0]);
  });

  it('uses a new key once the first attempt got a clear answer', async () => {
    serve(() => respond(200, { ok: true, data: {} }));
    const body = { body: { userId: 'u', amountCent: 5000 }, idempotent: true };
    await apiSend('/api/admin/adjustments', body);
    await apiSend('/api/admin/adjustments', body);
    const keys = calls.map((c) => (c.init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
