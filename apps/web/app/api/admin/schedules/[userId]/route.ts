import { NextResponse } from 'next/server';
import { identity, unauthorized } from '@/lib/auth/identity';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { csrfFromRequest } from '@/lib/auth/csrf';
import { writeAuditLog } from '@/lib/services/audit';
import { weekInForce, todayInBeirut } from 'time';

const Body = z.object({
  weeklySchedule: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      shift_hours: z.number().min(0).max(24),
    }),
  ),
});

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function GET(_req: Request, ctx: { params: { userId: string } }) {
  const me = await identity();
  if (!me) return unauthorized();
  const role = me.role;
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);

  const [rows, overrides, pendingLeaves] = await Promise.all([
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

  // The hours in force today, one per weekday - the older rows are history
  // that past days are still judged against. A weekday that is off is left
  // out, as it always was.
  const weeklySchedule = weekInForce(rows, todayInBeirut()).filter((r) => r.shift_min > 0);
  return NextResponse.json({ ok: true, data: { weeklySchedule, overrides, pendingLeaves } });
}

export async function PUT(req: Request, ctx: { params: { userId: string } }) {
  const me = await identity();
  if (!me) return unauthorized();
  const role = me.role;
  const adminId = me.userId;
  if (role !== 'ADMIN') return jsonError('FORBIDDEN', 'Admin only', 403);
  if (!adminId) return jsonError('UNAUTHORIZED', 'Authentication required', 401);

  if (!csrfFromRequest(req)) return jsonError('FORBIDDEN', 'CSRF token mismatch', 403);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return jsonError('INVALID_INPUT', 'Invalid request body: ' + (err instanceof Error ? err.message : ''), 400);
  }

  // A change applies from today. Past days keep the hours they were judged
  // against - deleting and rewriting the rows used to re-judge every day ever
  // worked, paid months included, against the new hours. Only the weekdays
  // that actually change get a row, and a weekday switched off gets a 0.
  const today = todayInBeirut();
  const effectiveFrom = new Date(`${today}T00:00:00.000Z`);
  const rows = await prisma.schedule.findMany({ where: { user_id: ctx.params.userId } });
  const before = weekInForce(rows, today);
  const wanted = new Map(body.weeklySchedule.map((s) => [s.weekday, Math.round(s.shift_hours * 60)]));

  await prisma.$transaction(async (tx) => {
    for (let weekday = 0; weekday <= 6; weekday++) {
      const shiftMin = wanted.get(weekday) ?? 0;
      const current = before.find((r) => r.weekday === weekday)?.shift_min ?? 0;
      if (shiftMin === current) continue;
      await tx.schedule.upsert({
        where: { user_id_weekday_effective_from: { user_id: ctx.params.userId, weekday, effective_from: effectiveFrom } },
        create: { user_id: ctx.params.userId, weekday, shift_min: shiftMin, effective_from: effectiveFrom },
        update: { shift_min: shiftMin },
      });
    }
    await writeAuditLog({
      actorId: adminId,
      action: 'schedule.update',
      entity: 'User',
      entityId: ctx.params.userId,
      before: { schedule: before.filter((s) => s.shift_min > 0).map((s) => ({ weekday: s.weekday, shift_min: s.shift_min })) },
      after: { schedule: body.weeklySchedule, effective_from: today },
      db: tx,
    });
  });

  return NextResponse.json({ ok: true, data: { weeklySchedule: body.weeklySchedule } });
}

export const dynamic = 'force-dynamic';
