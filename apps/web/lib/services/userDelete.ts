import type { PrismaClient } from '@prisma/client';

/**
 * What a person owns that makes deleting them destroy a record.
 *
 * The split is between what somebody DID and how they were SET UP. A punch, a
 * trip, an advance, a penalty ruling: those are the attendance record and the
 * money, and a month already paid has to stay reconstructible from them. A
 * schedule, a pay rate, a push subscription: those describe an account, mean
 * nothing once it is gone, and every account has some from the moment it is
 * created - counting them would mean nobody could ever be deleted at all.
 *
 * `driverCall` counts on both sides. A caller who has rung drivers is part of
 * those trips' history even though they never punched.
 *
 * Deliberately NOT counted: Flag, LeaveRequest, ScheduleOverride. A flag is
 * monitoring noise the system raises on its own, and someone flagged once for
 * failing to show up on their first day should still be deletable. Anyone who
 * actually worked has punches, which do count.
 */
export interface UserHistory {
  punches: number;
  trips: number;
  advances: number;
  adjustments: number;
  penaltyWaivers: number;
  penaltyAcks: number;
  overtimeDecisions: number;
  blockedCreditDecisions: number;
  blockedPunches: number;
  driverCalls: number;
}

export function hasHistory(h: UserHistory): boolean {
  return Object.values(h).some((n) => n > 0);
}

export async function userHistory(db: PrismaClient, userId: string): Promise<UserHistory> {
  const [
    punches,
    trips,
    advances,
    adjustments,
    penaltyWaivers,
    penaltyAcks,
    overtimeDecisions,
    blockedCreditDecisions,
    blockedPunches,
    callsReceived,
    callsMade,
  ] = await Promise.all([
    db.punch.count({ where: { user_id: userId } }),
    db.trip.count({ where: { driver_id: userId } }),
    db.advance.count({ where: { user_id: userId } }),
    db.adjustment.count({ where: { user_id: userId } }),
    db.penaltyWaiver.count({ where: { user_id: userId } }),
    db.penaltyAck.count({ where: { user_id: userId } }),
    db.overtimeDecision.count({ where: { user_id: userId } }),
    db.blockedCreditDecision.count({ where: { user_id: userId } }),
    db.blockedPunchAttempt.count({ where: { user_id: userId } }),
    db.driverCall.count({ where: { driver_id: userId } }),
    db.driverCall.count({ where: { caller_id: userId } }),
  ]);
  return {
    punches,
    trips,
    advances,
    adjustments,
    penaltyWaivers,
    penaltyAcks,
    overtimeDecisions,
    blockedCreditDecisions,
    blockedPunches,
    driverCalls: callsReceived + callsMade,
  };
}

/**
 * Remove the rows that describe an account, then the account.
 *
 * Only ever called once userHistory has come back empty, so nothing here can
 * discard a punch or a payment - these are the setup rows, plus the two kinds
 * of record that are meaningless without the person they were about.
 *
 * Every one is a required relation with no onDelete, which Prisma defaults to
 * Restrict, so each has to be cleared explicitly or Postgres refuses the
 * delete. That is a feature: adding a new table that references User will break
 * this loudly rather than silently orphaning rows.
 *
 * The audit trail is untouched on purpose. AuditLog.actor_id has no foreign key
 * (see writeAuditLog), so everything this person ever did to the system, and
 * everything done to them, outlives the account - including the row recording
 * this deletion.
 */
export async function deleteUserAndSetup(db: PrismaClient, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.pushSubscription.deleteMany({ where: { user_id: userId } });
    await tx.scheduleOverride.deleteMany({ where: { user_id: userId } });
    await tx.schedule.deleteMany({ where: { user_id: userId } });
    await tx.leaveRequest.deleteMany({ where: { user_id: userId } });
    await tx.rateChange.deleteMany({ where: { user_id: userId } });
    // Flag.user_id is nullable, so this would survive as an orphan rather than
    // block. A flag naming nobody is worse than no flag.
    await tx.flag.deleteMany({ where: { user_id: userId } });
    await tx.user.delete({ where: { id: userId } });
  });
}
