import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes } from 'crypto';

export type Role = 'EMPLOYEE' | 'DRIVER' | 'ADMIN' | 'CALLER';

/**
 * Which cookie a token belongs in. Both are signed with the same key, so
 * without this a refresh token (7 days) copied into the access cookie was
 * simply accepted - a week of access that nothing could shorten.
 */
export type TokenKind = 'access' | 'refresh';

export interface JwtPayload extends JWTPayload {
  sub: string;
  role: Role;
  branchId: string | null;
  /** User.session_version when issued; a refresh at an older version is refused. */
  sv: number;
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
  payload: { sub: string; role: Role; branchId: string | null; sv: number },
  expiresAt: Date,
  kind: TokenKind,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return await new SignJWT({ role: payload.role, branchId: payload.branchId, sv: payload.sv, typ: kind })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(getSecret());
}

export async function verifyToken(token: string, kind: TokenKind): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string') return null;
    const claims = payload as Record<string, unknown>;
    // A token of the other kind, or from before kinds existed, is not this one.
    if (claims.typ !== kind) return null;
    if (typeof claims.sv !== 'number') return null;
    const role = claims.role;
    const branchId = claims.branchId;
    if (role !== 'EMPLOYEE' && role !== 'DRIVER' && role !== 'ADMIN' && role !== 'CALLER') return null;
    return {
      ...payload,
      sub: payload.sub,
      role: role as Role,
      branchId: branchId === null ? null : typeof branchId === 'string' ? branchId : null,
      sv: claims.sv,
      exp: typeof payload.exp === 'number' ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}