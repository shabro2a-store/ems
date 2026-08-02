import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

// Mark a flag as resolved/acknowledged. notified_at doubles as the resolved marker.

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);
  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  const flag = await prisma.flag.findUnique({ where: { id: params.id } });
  if (!flag) return jsonError('NOT_FOUND', 'Flag not found', 404);
  if (flag.resolved_at) {
    return NextResponse.json({ ok: true, data: { id: flag.id, resolved_at: flag.resolved_at.toISOString() } });
  }

  const updated = await prisma.flag.update({
    where: { id: params.id },
    data: { resolved_at: new Date() },
  });
  await writeAuditLog({
    actorId: adminId,
    action: 'flag.resolve',
    entity: 'Flag',
    entityId: flag.id,
    before: { resolved_at: null },
    after: { resolved_at: updated.resolved_at?.toISOString() ?? null },
  });

  return NextResponse.json({ ok: true, data: { id: updated.id, resolved_at: updated.resolved_at?.toISOString() ?? null } });
}

export const dynamic = 'force-dynamic';
