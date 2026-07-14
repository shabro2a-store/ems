import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';

const Body = z.object({
  weeklySchedule: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      start_time: z.string().regex(/^\d{2}:\d{2}$/),
      end_time: z.string().regex(/^\d{2}:\d{2}$/),
    }),
  ),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(_req: Request, ctx: { params: { userId: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const [weeklySchedule, overrides, pendingLeaves] = await Promise.all([
    prisma.schedule.findMany({
      where: { user_id: ctx.params.userId },
      orderBy: { weekday: 'asc' },
    }),
    prisma.scheduleOverride.findMany({
      where: { user_id: ctx.params.userId },
      orderBy: { date: 'asc' },
    }),
    prisma.leaveRequest.findMany({
      where: { user_id: ctx.params.userId, status: 'PENDING' },
      orderBy: { created_at: 'desc' },
    }),
  ]);

  return NextResponse.json({ ok: true, data: { weeklySchedule, overrides, pendingLeaves } });
}

export async function PUT(req: Request, ctx: { params: { userId: string } }) {
  const h = headers();
  const role = h.get('x-user-role');
  const adminId = h.get('x-user-id');
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  const before = await prisma.schedule.findMany({ where: { user_id: ctx.params.userId } });

  await prisma.$transaction(async (tx) => {
    await tx.schedule.deleteMany({ where: { user_id: ctx.params.userId } });
    if (body.weeklySchedule.length > 0) {
      await tx.schedule.createMany({
        data: body.weeklySchedule.map((s) => ({
          user_id: ctx.params.userId,
          weekday: s.weekday,
          start_time: s.start_time,
          end_time: s.end_time,
        })),
      });
    }
  });

  await writeAuditLog({
    actorId: adminId,
    action: 'schedule.update',
    entity: 'User',
    entityId: ctx.params.userId,
    before: { schedule: before.map((s) => ({ weekday: s.weekday, start_time: s.start_time, end_time: s.end_time })) },
    after: { schedule: body.weeklySchedule },
  });

  return NextResponse.json({ ok: true, data: { weeklySchedule: body.weeklySchedule } });
}

export const dynamic = 'force-dynamic';