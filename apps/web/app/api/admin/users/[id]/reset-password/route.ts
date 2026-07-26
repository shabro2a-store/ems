import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { randomBytes } from 'crypto';

function generateTempPassword(): string {
  const bytes = randomBytes(9);
  const b64 = bytes.toString('base64');
  return b64.replace(/[+/=]/g, '').slice(0, 12);
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  const user = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!user) return jsonError('NOT_FOUND', 'User not found', 404);

  // Admin may either set a chosen password or leave it blank for a random one.
  let chosen: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < 6 || body.password.length > 256) {
        return jsonError('INVALID_INPUT', 'Password must be 6-256 characters', 400);
      }
      chosen = body.password;
    }
  } catch {
    /* no body — fall through to random */
  }

  const tempPassword = chosen ?? generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  await prisma.user.update({
    where: { id: ctx.params.id },
    data: { password_hash: passwordHash },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'user.reset_password',
    entity: 'User',
    entityId: ctx.params.id,
  });

  return NextResponse.json({ ok: true, data: { temp_password: tempPassword } });
}

export const dynamic = 'force-dynamic';