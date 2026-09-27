import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { verifyToken, type Role } from './jwt';
import { ACCESS_COOKIE_NAME } from './constants';

export interface Identity {
  userId: string;
  role: Role;
  branchId: string | null;
}

/**
 * Who is asking: the signed access cookie, checked against the database.
 *
 * Never the x-user-* request headers. Those were set by the middleware, so
 * anything that got a request past it - the CVE fixed in c121b6c did exactly
 * that - was believed. And the middleware cannot read the database, so a
 * session ended by a reset, a retirement or a sign-out elsewhere kept working
 * until its token ran out. Here it ends on the next request.
 *
 * null means "not signed in": answer 401 (or send a page to /login).
 */
export async function identity(): Promise<Identity | null> {
  const token = cookies().get(ACCESS_COOKIE_NAME)?.value;
  const payload = token ? await verifyToken(token, 'access') : null;
  if (!payload) return null;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { is_active: true, session_version: true },
  });
  if (!user || !user.is_active || user.session_version !== payload.sv) return null;
  return { userId: payload.sub, role: payload.role, branchId: payload.branchId };
}

export function unauthorized() {
  return NextResponse.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, { status: 401 });
}
