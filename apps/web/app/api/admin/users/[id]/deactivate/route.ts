import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

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

  const before = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!before) return jsonError('NOT_FOUND', 'User not found', 404);

  const user = await prisma.user.update({
    where: { id: ctx.params.id },
    data: { is_active: !before.is_active },
  });

  await writeAuditLog({
    actorId: adminId,
    action: user.is_active ? 'user.reactivate' : 'user.deactivate',
    entity: 'User',
    entityId: user.id,
    before: { is_active: before.is_active },
    after: { is_active: user.is_active },
  });

  return NextResponse.json({ ok: true, data: { user } });
}

export const dynamic = 'force-dynamic';