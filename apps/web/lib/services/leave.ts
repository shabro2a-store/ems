import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/db/prisma';
import { todayInBeirut, beirutWeekday } from 'time';
import { writeAuditLog } from './audit';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RequestLeaveInput {
  userId: string;
  kind: 'DAY_OFF' | 'HOURS_CHANGE';
  startDate: string;
  endDate: string;
  hoursOff?: number | null;
  note?: string | null;
}

export type RequestLeaveResult =
  | { ok: true; id: string; status: 'PENDING' }
  | { ok: false; code: 'INVALID_INPUT' | 'PAST_DATE' };

export async function requestLeave(
  input: RequestLeaveInput,
  db: PrismaClient = defaultPrisma,
): Promise<RequestLeaveResult> {
  if (!DATE_RE.test(input.startDate) || !DATE_RE.test(input.endDate)) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const start = new Date(`${input.startDate}T00:00:00.000Z`);
  const end = new Date(`${input.endDate}T00:00:00.000Z`);
  const today = new Date(`${todayInBeirut()}T00:00:00.000Z`);
  if (start < today) return { ok: false, code: 'PAST_DATE' };
  if (input.hoursOff != null && (input.hoursOff < 0 || input.hoursOff > 24)) {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  const leave = await db.leaveRequest.create({
    data: {
      user_id: input.userId,
      kind: input.kind,
      start_date: start,
      end_date: end,
      off_min: input.hoursOff != null ? Math.round(input.hoursOff * 60) : null,
      note: input.note ?? null,
      status: 'PENDING',
    },
  });

  await writeAuditLog({
    actorId: input.userId,
    action: 'leave.create',
    entity: 'LeaveRequest',
    entityId: leave.id,
    after: { kind: leave.kind, start_date: input.startDate, end_date: input.endDate },
    db,
  });

  return { ok: true, id: leave.id, status: 'PENDING' };
}

export interface DecideLeaveInput {
  adminId: string;
  leaveId: string;
  decision: 'APPROVED' | 'REJECTED';
  db?: PrismaClient;
}

export type DecideLeaveResult =
  | { ok: true; id: string; status: 'APPROVED' | 'REJECTED'; overrides_created: number }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'INVALID_INPUT' };

export async function decideLeave(
  input: DecideLeaveInput,
): Promise<DecideLeaveResult> {
  const db = input.db ?? defaultPrisma;
  if (input.decision !== 'APPROVED' && input.decision !== 'REJECTED') {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const leave = await db.leaveRequest.findUnique({ where: { id: input.leaveId } });
  if (!leave) return { ok: false, code: 'NOT_FOUND' };
  if (leave.status !== 'PENDING') return { ok: false, code: 'ALREADY_DECIDED' };

  const now = new Date();
  let overridesCreated = 0;

  await db.$transaction(async (tx) => {
    if (input.decision === 'APPROVED') {
      const dates: string[] = [];
      const cursor = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      while (cursor.getTime() <= end.getTime()) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      // DAY_OFF never looks at the schedule - it always resolves to zero
      // required minutes. Only load it when there is a subtraction to do, and
      // load it once: a request can span many dates, each landing on a
      // different weekday.
      const shiftMinByWeekday = new Map<number, number>();
      if (leave.kind === 'HOURS_CHANGE') {
        const schedules = await tx.schedule.findMany({
          where: { user_id: leave.user_id },
          select: { weekday: true, shift_min: true },
        });
        for (const s of schedules) shiftMinByWeekday.set(s.weekday, s.shift_min ?? 0);
      }

      for (const dateStr of dates) {
        const dateOnly = new Date(`${dateStr}T00:00:00.000Z`);
        const shiftMin = leave.kind === 'HOURS_CHANGE'
          ? Math.max(0, (shiftMinByWeekday.get(beirutWeekday(dateOnly)) ?? 0) - (leave.off_min ?? 0))
          : null;

        await tx.scheduleOverride.upsert({
          where: { user_id_date: { user_id: leave.user_id, date: dateOnly } },
          create: {
            user_id: leave.user_id,
            date: dateOnly,
            kind: leave.kind,
            shift_min: shiftMin,
            note: leave.note,
            source: 'EMPLOYEE_REQUEST',
          },
          update: {
            kind: leave.kind,
            shift_min: shiftMin,
            note: leave.note,
            source: 'EMPLOYEE_REQUEST',
          },
        });
        overridesCreated += 1;
      }
    }
    await tx.leaveRequest.update({
      where: { id: input.leaveId },
      data: { status: input.decision, decided_by: input.adminId, decided_at: now },
    });
  });

  await writeAuditLog({
    actorId: input.adminId,
    action: input.decision === 'APPROVED' ? 'leave.approved' : 'leave.rejected',
    entity: 'LeaveRequest',
    entityId: input.leaveId,
    before: { status: 'PENDING' },
    after: { status: input.decision, overrides_created: overridesCreated },
    db,
  });

  return { ok: true, id: input.leaveId, status: input.decision, overrides_created: overridesCreated };
}

export interface LeaveSummary {
  pending: number;
  upcoming: Array<{
    date: string;
    kind: 'DAY_OFF' | 'HOURS_CHANGE';
    shift_min: number | null;
    note: string | null;
  }>;
}

export async function leaveSummary(
  userId: string,
  db: PrismaClient = defaultPrisma,
): Promise<LeaveSummary> {
  const today = todayInBeirut();
  const todayDate = new Date(`${today}T00:00:00.000Z`);

  const [pending, upcoming] = await Promise.all([
    db.leaveRequest.count({ where: { user_id: userId, status: 'PENDING' } }),
    db.scheduleOverride.findMany({
      where: { user_id: userId, date: { gte: todayDate } },
      orderBy: { date: 'asc' },
      take: 20,
    }),
  ]);

  return {
    pending,
    upcoming: upcoming.map((o) => ({
      date: o.date.toISOString().slice(0, 10),
      kind: o.kind,
      shift_min: o.shift_min,
      note: o.note,
    })),
  };
}
