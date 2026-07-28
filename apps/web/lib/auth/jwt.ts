import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes } from 'crypto';

export type Role = 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER';

export interface JwtPayload extends JWTPayload {
  sub: string;
  role: Role;
  branchId: string | null;
  exp: number;
}

function getSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET missing or too short');
  }
  return new TextEncoder().encode(s);
}

export function newJwtSecret(): string {
  return randomBytes(48).toString('hex');
}

export async function signToken(
  payload: { sub: string; role: Role; branchId: string | null },
  expiresAt: Date,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return await new SignJWT({ role: payload.role, branchId: payload.branchId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    const role = (payload as Record<string, unknown>).role;
    const branchId = (payload as Record<string, unknown>).branchId;
    if (role !== 'EMPLOYEE' && role !== 'DRIVER' && role !== 'ADMIN' && role !== 'CALLER') return null;
    return {
      ...payload,
      sub: payload.sub,
      role: role as Role,
      branchId: branchId === null ? null : typeof branchId === 'string' ? branchId : null,
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}