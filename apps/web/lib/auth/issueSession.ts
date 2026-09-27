import type { PrismaClient, Role } from '@prisma/client';
import { signToken, verifyToken } from './jwt';
import { generateCsrfToken } from './csrf';
import { accessExpiry } from './session';
import { setAuthCookies } from './cookies';
import { REFRESH_TTL_DAYS } from './constants';

/**
 * Sign a fresh access and refresh pair for this person, at their current
 * session version, and set the cookies. Sign-in, renewal and changing your own
 * password all end here, so they cannot disagree about what a session is.
 */
export async function issueSession(
  db: PrismaClient,
  user: { id: string; role: Role; branch_id: string | null; session_version: number },
  now: Date = new Date(),
): Promise<void> {
  const exp = accessExpiry(now);
  const claims = { sub: user.id, role: user.role, branchId: user.branch_id ?? null, sv: user.session_version };
  const access = await signToken(claims, exp, 'access');
  const refresh = await signToken(claims, new Date(now.getTime() + REFRESH_TTL_DAYS * 86_400_000), 'refresh');
  setAuthCookies(access, refresh, generateCsrfToken(), exp);
}

/**
 * Renew a session from its refresh token, or say it has ended.
 *
 * Every way a session ends - sign-out, a password reset or change, a role
 * change, deactivation, retirement - moves session_version on, and a refresh
 * token issued before that is refused here. Role and branch come from the row,
 * not the token, so a renewal never hands back what the owner has taken away.
 */
export async function renewFromRefreshToken(db: PrismaClient, refreshToken: string): Promise<boolean> {
  const payload = await verifyToken(refreshToken, 'refresh');
  if (!payload) return false;
  const user = await db.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, branch_id: true, session_version: true, is_active: true, deleted_at: true },
  });
  if (!user || !user.is_active || user.deleted_at || user.session_version !== payload.sv) return false;
  await issueSession(db, user);
  return true;
}
