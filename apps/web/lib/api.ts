// Shared client-side API helpers. Replaces the csrfFromCookie/idemKey/fetch
// boilerplate that was copy-pasted across ~10 page components.

export function csrfFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return m?.[1] ?? '';
}

export function idemKey(prefix = 'web'): string {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}
export type ApiResult<T> = ApiOk<T> | ApiErr;

// Human-readable message for an error envelope, falling back to the code.
export function errorMessage(err: ApiErr | { code?: string; message?: string } | null | undefined): string {
  if (!err) return 'Something went wrong.';
  const e = 'error' in (err as ApiErr) ? (err as ApiErr).error : (err as { code?: string; message?: string });
  return e?.message || e?.code || 'Something went wrong.';
}

// ---- staying signed in ----
//
// The access token lives a quarter of an hour. A request that comes back 401
// renews the session once - one renewal shared by every request that lapsed
// together - and is sent again. If the renewal is refused the session really
// has ended (signed out elsewhere, reset, retired), and the only honest thing
// to show is the sign-in page: before this, every screen simply froze on what
// it last had.

let renewing: Promise<boolean> | null = null;

function renewSession(): Promise<boolean> {
  renewing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-CSRF-Token': csrfFromCookie() },
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

/**
 * fetch, but a lapsed session is renewed and the request repeated. `send` is
 * called again for the repeat, so it can read the CSRF token the renewal just
 * rotated. Sign-in, sign-out and renewal themselves are left alone - a wrong
 * password is a 401 too.
 */
export async function apiFetch(url: string, send: () => Promise<Response>): Promise<Response> {
  const res = await send();
  if (res.status !== 401 || url.startsWith('/api/auth/')) return res;
  if (await renewSession()) return send();
  if (typeof window !== 'undefined') window.location.assign('/login');
  return res;
}

export async function apiGet<T = unknown>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await apiFetch(url, () => fetch(url, { credentials: 'include' }));
    return (await res.json()) as ApiResult<T>;
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: 'Network error — check your connection.' } };
  }
}

interface SendOpts {
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotent?: boolean;
  idemPrefix?: string;
}

export async function apiSend<T = unknown>(url: string, opts: SendOpts = {}): Promise<ApiResult<T>> {
  const { method = 'POST', body, idempotent = false, idemPrefix = 'web' } = opts;
  // One key for the request, repeats included: it is the same request.
  const key = idempotent ? idemKey(idemPrefix) : null;
  const send = () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfFromCookie(),
    };
    if (key) headers['Idempotency-Key'] = key;
    return fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  try {
    const res = await apiFetch(url, send);
    return (await res.json()) as ApiResult<T>;
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: 'Network error — check your connection.' } };
  }
}

interface SendFormOpts {
  form: FormData;
  idempotent?: boolean;
  idemPrefix?: string;
}

// The same envelope as apiSend, for a request that carries a file. No
// Content-Type header: the browser writes the multipart boundary itself.
export async function apiSendForm<T = unknown>(url: string, opts: SendFormOpts): Promise<ApiResult<T>> {
  const { form, idempotent = false, idemPrefix = 'web' } = opts;
  const key = idempotent ? idemKey(idemPrefix) : null;
  const send = () => {
    const headers: Record<string, string> = { 'X-CSRF-Token': csrfFromCookie() };
    if (key) headers['Idempotency-Key'] = key;
    return fetch(url, { method: 'POST', credentials: 'include', headers, body: form });
  };
  try {
    const res = await apiFetch(url, send);
    return (await res.json()) as ApiResult<T>;
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: 'Network error — check your connection.' } };
  }
}

// ---- formatting ----

export function centsToUsd(cents: number, withSymbol = true): string {
  const v = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? `$${v}` : v;
}

export function formatBeirut(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', ...opts });
}

export function formatBeirutTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Beirut',
    hour: '2-digit',
    minute: '2-digit',
  });
}
