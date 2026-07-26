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

export async function apiGet<T = unknown>(url: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { credentials: 'include' });
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfFromCookie(),
  };
  if (idempotent) headers['Idempotency-Key'] = idemKey(idemPrefix);
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
