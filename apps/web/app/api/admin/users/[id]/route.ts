import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

const Patch = z.object({
  role: z.enum(['EMPLOYEE', 'DRIVER', 'ADMIN']).optional(),
  branchId: z.string().nullable().optional(),
  hourlyRateCent: z.number().int().nonnegative().optional(),
});

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

  const before = await prisma.user.findUnique({ where: { id: ctx.params.id } });
  if (!before) return jsonError('NOT_FOUND', 'User not found', 404);

  let nextRole = body.role ?? before.role;
  if (nextRole === 'ADMIN') {
    body = { ...body, branchId: null };
  }

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: ctx.params.id },
      data: {
        ...(body.role ? { role: body.role } : {}),
        ...(body.branchId !== undefined ? { branch_id: body.branchId } : {}),
        ...(body.hourlyRateCent !== undefined && body.hourlyRateCent !== before.hourly_rate_cent
          ? { hourly_rate_cent: body.hourlyRateCent }
          : {}),
      },
    });
    if (body.hourlyRateCent !== undefined && body.hourlyRateCent !== before.hourly_rate_cent) {
      await tx.rateChange.create({
        data: {
          user_id: updated.id,
          rate_cent: body.hourlyRateCent,
          effective_from: new Date(),
        },
      });
    }
    return updated;
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'user.update',
    entity: 'User',
    entityId: user.id,
    before: { role: before.role, branch_id: before.branch_id, hourly_rate_cent: before.hourly_rate_cent },
    after: { role: user.role, branch_id: user.branch_id, hourly_rate_cent: user.hourly_rate_cent },
  });

  return NextResponse.json({ ok: true, data: { user } });
}

export const dynamic = 'force-dynamic';