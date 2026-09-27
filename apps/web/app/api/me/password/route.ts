import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { verifyPassword } from '@/lib/auth/password';
import { writeAuditLog } from '@/lib/services/audit';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/constants';
import { issueSession } from '@/lib/auth/issueSession';

const Body = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(256),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Only the admin manages passwords. The admin may change their own here;
// employees / drivers / callers cannot self-serve (admin resets theirs via
// /api/admin/users/[id]/reset-password).
export async function POST(req: Request) {
  const me = await identity();
  if (!me) return unauthorized();
  const userId = me.userId;
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (me.role !== 'ADMIN') {
    return jsonError('FORBIDDEN', 'Only the admin can change passwords', 403);
  }
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return jsonError('INVALID_INPUT', `New password must be at least ${PASSWORD_MIN_LENGTH} characters`, 400);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const ok = await verifyPassword(body.currentPassword, user.password_hash);
  if (!ok) return jsonError('WRONG_PASSWORD', 'Your current password is incorrect', 400);

  // Every other session - a stolen cookie included - ends with the old
  // password; this one is signed again at the new version so the owner stays in.
  const passwordHash = await bcrypt.hash(body.newPassword, 12);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { password_hash: passwordHash, session_version: { increment: 1 } },
    select: { id: true, role: true, branch_id: true, session_version: true },
  });
  await issueSession(prisma, updated);

  await writeAuditLog({ actorId: userId, action: 'user.change_password', entity: 'User', entityId: userId });

  return NextResponse.json({ ok: true, data: { changed: true } });
}

export const dynamic = 'force-dynamic';
