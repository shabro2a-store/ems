import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

const Patch = z.object({
  dailySummary: z.boolean().optional(),
  routinePings: z.boolean().optional(),
}).strict();

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Patch>;
  try {
    body = Patch.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  if (body.dailySummary === undefined && body.routinePings === undefined) {
    return jsonError('INVALID_INPUT', 'At least one field required', 400);
  }

  const before = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!before) return jsonError('NOT_FOUND', 'User not found', 404);

  const user = await prisma.user.update({
    where: { id: ctx.params.id },
    data: {
      ...(body.dailySummary !== undefined ? { notify_daily_summary: body.dailySummary } : {}),
      ...(body.routinePings !== undefined ? { notify_routine_pings: body.routinePings } : {}),
    },
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'user.notification_prefs',
    entity: 'User',
    entityId: user.id,
    before: { daily_summary: before.notify_daily_summary, routine_pings: before.notify_routine_pings },
    after: { daily_summary: user.notify_daily_summary, routine_pings: user.notify_routine_pings },
  });

  return NextResponse.json({ ok: true, data: { user } });
}

export const dynamic = 'force-dynamic';