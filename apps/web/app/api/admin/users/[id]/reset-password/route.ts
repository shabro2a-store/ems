import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/constants';
import { randomBytes } from 'crypto';

function generateTempPassword(): string {
  const bytes = randomBytes(9);
  const b64 = bytes.toString('base64');
  return b64.replace(/[+/=]/g, '').slice(0, 12);
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const me = await identity();
  if (!me) return unauthorized();
  const role = me.role;
  const adminId = me.userId;
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);
  // This route needs no current password, so on the owner's own account it
  // would hand the admin login to anyone at an unlocked admin tab. Their own
  // goes through the Password dialog, which asks for the current one.
  if (id === adminId) {
    return jsonError('OWN_PASSWORD', 'Change your own password with the Password button at the top of the page.', 400);
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return jsonError('NOT_FOUND', 'User not found', 404);

  // Admin may either set a chosen password or leave it blank for a random one.
  let chosen: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < PASSWORD_MIN_LENGTH || body.password.length > 256) {
        return jsonError('INVALID_INPUT', `Password must be ${PASSWORD_MIN_LENGTH}-256 characters`, 400);
      }
      chosen = body.password;
    }
  } catch {
    /* no body — fall through to random */
  }

  const tempPassword = chosen ?? generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  // A new password ends every session opened with the old one - which is
  // usually the reason for resetting it.
  await prisma.user.update({
    where: { id },
    data: { password_hash: passwordHash, session_version: { increment: 1 } },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'user.reset_password',
    entity: 'User',
    entityId: id,
  });

  return NextResponse.json({ ok: true, data: { temp_password: tempPassword } });
}

export const dynamic = 'force-dynamic';