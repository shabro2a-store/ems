export interface LoginSession {
  cookies: string;
  csrf: string;
}

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';

function parseSetCookies(headers: Headers): Map<string, string> {
  const map = new Map<string, string>();
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.bind(headers);
  const cookies: string[] = getSetCookie ? getSetCookie() : [];
  if (cookies.length === 0) {
    const raw = headers.get('set-cookie');
    if (raw) {
      for (const part of raw.split(/,(?=[^;]+=)/)) cookies.push(part.trim());
    }
  }
  for (const c of cookies) {
    const first = c.split(';')[0]!;
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

function cookieHeader(map: Map<string, string>): string {
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function loginAs(username: string, password: string): Promise<LoginSession> {
  const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
        'x-real-ip': ip,
      },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    throw new Error(`login network error for ${username}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login failed for ${username}: ${res.status} ${body.slice(0, 200)}`);
  }
  const jar = parseSetCookies(res.headers);
  const csrf = jar.get('csrf');
  if (!csrf) throw new Error(`login did not return csrf cookie for ${username}`);
  return { cookies: cookieHeader(jar), csrf };
}
