import type { PrismaClient, Role } from '@prisma/client';
import { signToken } from './jwt';
import { generateCsrfToken } from './csrf';
import { sessionExpiryFor } from './session';
import { setAuthCookies } from './cookies';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Sign a fresh access and refresh pair for this person, at their current
 * session version, and set the cookies. Sign-in, refresh and changing your own
 * password all end here, so the three cannot disagree about what a session is.
 */
export async function issueSession(
  db: PrismaClient,
  user: { id: string; role: Role; branch_id: string | null; session_version: number },
  now: Date = new Date(),
): Promise<void> {
  const lastPunch = await db.punch.findFirst({
    where: { user_id: user.id },
    orderBy: { at: 'desc' },
    select: { kind: true },
  });
  const exp = sessionExpiryFor({ role: user.role }, lastPunch?.kind === 'IN', now);
  const claims = { sub: user.id, role: user.role, branchId: user.branch_id ?? null, sv: user.session_version };
  const access = await signToken(claims, exp, 'access');
  const refresh = await signToken(claims, new Date(now.getTime() + REFRESH_TTL_MS), 'refresh');
  setAuthCookies(access, refresh, generateCsrfToken(), exp);
}
