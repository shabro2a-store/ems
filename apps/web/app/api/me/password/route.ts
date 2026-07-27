import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { verifyPassword } from '@/lib/auth/password';
import { writeAuditLog } from '@/lib/services/audit';

const Body = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(6).max(256),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

// Only the admin manages passwords. The admin may change their own here;
// employees / drivers / callers cannot self-serve (admin resets theirs via
// /api/admin/users/[id]/reset-password).
export async function POST(req: Request) {
  const h = headers();
  const userId = h.get('x-user-id');
  if (!userId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (h.get('x-user-role') !== 'ADMIN') {
    return jsonError('FORBIDDEN', 'Only the admin can change passwords', 403);
  }
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return jsonError('INVALID_INPUT', 'New password must be at least 6 characters', 400);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  const ok = await verifyPassword(body.currentPassword, user.password_hash);
  if (!ok) return jsonError('WRONG_PASSWORD', 'Your current password is incorrect', 400);

  const passwordHash = await bcrypt.hash(body.newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { password_hash: passwordHash } });

  await writeAuditLog({ actorId: userId, action: 'user.change_password', entity: 'User', entityId: userId });

  return NextResponse.json({ ok: true, data: { changed: true } });
}

export const dynamic = 'force-dynamic';
